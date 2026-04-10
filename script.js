const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '198.23.239.134';
const PROXY_PORT = '6540';

if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const humanDelay = async (min = 500, max = 2000) => {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    await delay(ms);
};

const humanMouseMove = async (page, targetX, targetY) => {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = {
            x: start.x + (Math.random() - 0.5) * 200,
            y: start.y + (Math.random() - 0.5) * 200
        };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * targetX;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * targetY;
        await page.mouse.move(x, y);
        await delay(Math.floor(Math.random() * 20) + 10);
    }
};

const randomScroll = async (page) => {
    const scrollY = Math.floor(Math.random() * 300) + 100;
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), scrollY);
    await humanDelay(300, 800);
    await page.evaluate((y) => window.scrollBy({ top: -y / 2, behavior: 'smooth' }), scrollY);
};

// Lister toutes les iframes avec leurs URLs
async function listAllFrames(page) {
    const frames = page.frames();
    console.log(`\n🖼️  ${frames.length} frame(s) détectée(s) :`);
    frames.forEach((frame, i) => {
        console.log(`   Frame ${i}: ${frame.url().substring(0, 100)}`);
    });
}

async function listAllButtons(page) {
    console.log('\n🔎 ANALYSE DE L\'INTERFACE (éléments visibles) :');
    const elements = await page.evaluate(() => {
        const selectors = 'button, a, input, [role="button"], [onclick]';
        const els = Array.from(document.querySelectorAll(selectors));
        return els
            .filter(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            })
            .map(el => ({
                tag: el.tagName,
                type: el.type || null,
                text: (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().substring(0, 40),
                id: el.id || null,
                class: el.className || null
            }));
    });
    elements.forEach((el, i) => {
        console.log(`${i+1}. [${el.tag}] ${el.type ? `type="${el.type}"` : ''} "${el.text}"`);
    });
    console.log(`✅ Total : ${elements.length} éléments interactifs visibles\n`);
}

async function waitForLoginSuccess(page, timeoutMs = 20000) {
    const start = Date.now();
    const selectors = [
        'a[href*="dashboard"]',
        'a[href*="account"]',
        'a:contains("Logout")',
        'a:contains("Sign out")',
        '.user-menu',
        '.navbar-user',
        '[data-testid="user-menu"]'
    ];
    while (Date.now() - start < timeoutMs) {
        for (const sel of selectors) {
            try {
                const el = await page.$(sel);
                if (el) return true;
            } catch (e) {}
        }
        if (!page.url().includes('login.php')) return true;
        await delay(1000);
    }
    return false;
}

// Gestion de Turnstile avec diagnostic étendu
async function handleTurnstileWithRetry(page, maxAttempts = 5, waitBetween = 3000) {
    console.log('🛡️ Attente de l\'iframe Turnstile (avec retry)...');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`   Tentative ${attempt}/${maxAttempts}...`);
        const frames = page.frames();
        const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        if (turnstileFrame) {
            console.log('✅ Iframe Turnstile trouvée');
            try {
                await turnstileFrame.waitForSelector('body', { timeout: 5000 });
                const frameBox = await turnstileFrame.boundingBox();
                if (frameBox) await humanMouseMove(page, frameBox.x + 150, frameBox.y + 150);
                await turnstileFrame.click('input[type="checkbox"]');
                console.log('✅ Clic sur la case Turnstile');

                // Attendre résolution
                const start = Date.now();
                while (Date.now() - start < 25000) {
                    const stillThere = page.frames().some(f => f.url().includes('challenges.cloudflare.com/turnstile'));
                    if (!stillThere) {
                        console.log('✅ Turnstile disparu, challenge résolu');
                        return true;
                    }
                    try {
                        const checked = await turnstileFrame.$eval('input[type="checkbox"]', cb => cb.checked);
                        if (checked) {
                            console.log('✅ Case Turnstile cochée');
                            await delay(3000);
                            return true;
                        }
                    } catch (e) {}
                    await delay(2000);
                }
                console.log('⚠️ Timeout résolution Turnstile');
                return false;
            } catch (e) {
                console.log(`⚠️ Erreur interaction : ${e.message}`);
            }
        }
        if (attempt < maxAttempts) {
            await delay(waitBetween);
        }
    }
    console.log('❌ Iframe Turnstile introuvable après plusieurs tentatives.');
    // Lister les frames pour diagnostic
    await listAllFrames(page);
    return false;
}

(async () => {
    let browser;
    const status = {
        success: false,
        time: new Date().toISOString(),
        message: ''
    };

    try {
        console.log('🚀 Lancement du navigateur avec proxy résidentiel...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--disable-blink-features=AutomationControlled',
                `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,720'
            ]
        });

        const page = await browser.newPage();
        await page.authenticate({ username: PROXY_USERNAME, password: PROXY_PASSWORD });
        console.log('✅ Proxy authentifié');

        page.on('dialog', async dialog => { await dialog.accept(); });
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // --- LOGIN ---
        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await humanDelay(1000, 2000);
        await randomScroll(page);

        console.log('⌨️ Remplissage identifiants...');
        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.click(emailSelector);
        await humanDelay(200, 400);
        await page.type(emailSelector, EMAIL, { delay: () => Math.floor(Math.random() * 80) + 30 });
        await humanDelay(400, 800);
        await humanMouseMove(page, 600, 400);
        await randomScroll(page);

        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.click(passwordSelector);
        await humanDelay(200, 400);
        await page.type(passwordSelector, PASSWORD, { delay: () => Math.floor(Math.random() * 100) + 40 });
        await humanDelay(500, 1000);
        await humanMouseMove(page, 700, 500);
        await randomScroll(page);

        // Lister les boutons avant clic
        await listAllButtons(page);

        // Trouver et cliquer sur "Log in"
        console.log('🔐 Recherche bouton "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });
        if (!loginButton) throw new Error('Bouton "Log in" introuvable');

        const box = await loginButton.boundingBox();
        if (box) await humanMouseMove(page, box.x + box.width / 2, box.y + box.height / 2);
        await humanDelay(200, 500);

        console.log('🖱️ Clic sur "Log in"...');
        await loginButton.click();

        // Attendre un peu après le clic
        await delay(3000);

        // Gérer Turnstile avec retry
        const turnstileResolved = await handleTurnstileWithRetry(page, 8, 4000);
        if (turnstileResolved) {
            console.log('✅ Turnstile résolu');
            await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
        } else {
            console.log('⚠️ Turnstile non résolu, on continue quand même...');
        }

        // Vérifier connexion
        console.log('🔍 Attente de confirmation de connexion...');
        const loggedIn = await waitForLoginSuccess(page, 15000);
        const currentUrl = page.url();
        console.log('📍 URL finale :', currentUrl);

        if (loggedIn || !currentUrl.includes('login.php')) {
            status.success = true;
            status.message = 'Connexion réussie !';
            console.log('✅ Connexion réussie !');
        } else {
            const errorMsg = await page.evaluate(() => {
                const err = document.querySelector('.alert-danger, .error, .message-error');
                return err ? err.textContent.trim() : null;
            });
            status.message = errorMsg ? `Échec: ${errorMsg}` : 'Échec de connexion';
            console.log('❌', status.message);
            await listAllButtons(page);
        }

    } catch (error) {
        console.error('❌ Erreur fatale :', error);
        status.message = error.message;

        // Capture d'écran
        try {
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
        } catch (e) {}
    } finally {
        if (browser) await browser.close();
    }

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC');
})();
