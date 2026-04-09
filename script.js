const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!EMAIL || !PASSWORD || !BROWSERLESS_TOKEN) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

// Délai aléatoire (ms)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const humanDelay = async (min = 500, max = 2000) => {
    const ms = Math.floor(Math.random() * (max - min) + min);
    await delay(ms);
};

// Mouvement de souris réaliste dans une frame donnée
async function humanMouseMove(frame, x, y, steps = 20) {
    const viewport = await frame.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const startX = Math.floor(viewport.width / 2);
    const startY = Math.floor(viewport.height / 2);
    await frame.evaluate((startX, startY, endX, endY, steps) => {
        const mouse = document.createElement('div');
        mouse.style.position = 'absolute';
        mouse.style.width = '10px';
        mouse.style.height = '10px';
        mouse.style.borderRadius = '50%';
        mouse.style.backgroundColor = 'rgba(0,0,0,0.1)';
        mouse.style.zIndex = '999999';
        document.body.appendChild(mouse);
        for (let i = 0; i <= steps; i++) {
            const cx = startX + (endX - startX) * (i / steps);
            const cy = startY + (endY - startY) * (i / steps);
            mouse.style.left = cx + 'px';
            mouse.style.top = cy + 'px';
            const event = new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true });
            document.elementFromPoint(cx, cy)?.dispatchEvent(event);
        }
        mouse.remove();
    }, startX, startY, x, y, steps);
    await humanDelay(100, 300);
}

// Fonction pour trouver l'iframe Turnstile
async function findTurnstileFrame(page) {
    const frames = page.frames();
    for (const frame of frames) {
        const url = frame.url();
        if (url.includes('challenges.cloudflare.com') && url.includes('turnstile')) {
            console.log(`✅ Iframe Turnstile trouvée : ${url}`);
            return frame;
        }
    }
    return null;
}

// Fonction pour attendre que Turnstile soit chargé dans l'iframe
async function waitForTurnstileWidget(turnstileFrame, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const widgetPresent = await turnstileFrame.evaluate(() => {
            return !!document.querySelector('input[type="checkbox"], .challenge-container, #challenge-stage, [data-size="normal"], [data-size="compact"]');
        });
        if (widgetPresent) return true;
        await delay(1000);
    }
    return false;
}

// Fonction principale pour interagir avec Turnstile
async function interactWithTurnstile(turnstileFrame) {
    console.log('🖱️ Simulation d\'interaction humaine dans l\'iframe Turnstile...');

    // Mouvements de souris aléatoires dans l'iframe
    for (let i = 0; i < 3; i++) {
        const x = Math.floor(Math.random() * 400) + 100;
        const y = Math.floor(Math.random() * 300) + 100;
        await humanMouseMove(turnstileFrame, x, y, 15);
        await humanDelay(200, 500);
    }

    // Essayer de trouver et cliquer sur la case à cocher Turnstile
    const clickResult = await turnstileFrame.evaluate(() => {
        // Sélecteurs possibles pour la case à cocher Turnstile
        const selectors = [
            'input[type="checkbox"]',
            '.challenge-container input[type="checkbox"]',
            '[data-size="normal"] input[type="checkbox"]',
            '#challenge-stage input[type="checkbox"]',
            'label[for*="checkbox"]',
            'div[role="checkbox"]',
            '.cb-i'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
                // Simuler un survol avant clic
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
                el.click();
                return { success: true, selector: sel };
            }
        }
        // Si aucun sélecteur ne marche, cliquer au centre de l'iframe (souvent le widget)
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const element = document.elementFromPoint(centerX, centerY);
        if (element) {
            element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            element.click();
            return { success: true, clicked: 'center' };
        }
        return { success: false };
    });

    if (clickResult.success) {
        console.log(`✅ Clic effectué sur Turnstile (${clickResult.selector || clickResult.clicked})`);
    } else {
        console.log('⚠️ Impossible de trouver un élément cliquable dans Turnstile.');
    }

    await humanDelay(2000, 4000);

    // Attendre que le challenge se résolve (max 20s) en surveillant la disparition de l'iframe ou un changement d'état
    console.log('⏳ Attente de la validation de Turnstile...');
    const start = Date.now();
    let resolved = false;
    while (Date.now() - start < 20000) {
        const isChecked = await turnstileFrame.evaluate(() => {
            const cb = document.querySelector('input[type="checkbox"]');
            return cb ? cb.checked : false;
        });
        if (isChecked) {
            console.log('✅ Case cochée, attente de validation...');
            resolved = true;
            break;
        }
        // Vérifier aussi si l'iframe a changé d'URL ou disparu
        await delay(2000);
    }

    if (resolved) {
        // Attendre un peu plus pour la redirection
        await humanDelay(3000, 5000);
    }

    return resolved;
}

(async () => {
    let browser;
    const status = {
        success: false,
        time: new Date().toISOString(),
        message: ''
    };

    try {
        console.log('🔗 Connexion à Browserless...');
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
        });

        const page = await browser.newPage();
        page.on('dialog', async dialog => { await dialog.accept(); });
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('🌐 Accès login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });

        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.type(emailSelector, EMAIL, { delay: 50 });
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 50 });

        // Attendre un peu pour que Turnstile s'injecte
        console.log('⏳ Attente de l\'apparition de Turnstile...');
        await delay(5000);

        // Chercher l'iframe Turnstile
        let turnstileFrame = await findTurnstileFrame(page);
        if (!turnstileFrame) {
            // Parfois Turnstile n'apparaît qu'après un focus ou un clic ailleurs
            console.log('🔄 Turnstile non trouvé, tentative de déclenchement par clic sur la page...');
            await page.click('body', { offset: { x: 500, y: 300 } });
            await delay(3000);
            turnstileFrame = await findTurnstileFrame(page);
        }

        if (!turnstileFrame) {
            console.log('❌ Iframe Turnstile introuvable. Capture pour diagnostic :');
            const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
            console.log('📸 CAPTURE_BASE64_START');
            console.log(screenshot);
            console.log('📸 CAPTURE_BASE64_END');
            throw new Error('Iframe Turnstile non détectée');
        }

        console.log('🎯 Interaction avec le widget Turnstile...');
        const turnstileResolved = await interactWithTurnstile(turnstileFrame);

        if (turnstileResolved) {
            console.log('✅ Turnstile semble validé. Tentative de clic sur "Log in"...');
            // Revenir à la page principale et cliquer sur Log in
            const loginButton = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(btn => btn.textContent.trim() === 'Log in');
            });
            if (loginButton) {
                await loginButton.click();
                console.log('🔐 Clic sur Log in effectué');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
                await delay(5000);

                // Vérifier si connecté
                if (!page.url().includes('login.php')) {
                    status.success = true;
                    status.message = 'Connexion réussie après Turnstile';
                } else {
                    status.message = 'Échec de connexion malgré Turnstile';
                }
            } else {
                status.message = 'Bouton Log in introuvable';
            }
        } else {
            status.message = 'Turnstile non résolu';
        }

        // Si toujours pas connecté, tenter une approche alternative : cliquer directement sur Log in et laisser Turnstile se résoudre après ?
        if (!status.success) {
            console.log('🔄 Tentative alternative : clic sur Log in et attente...');
            const loginButton = await page.$('button');
            if (loginButton) {
                await loginButton.click();
                await delay(15000);
                if (!page.url().includes('login.php')) {
                    status.success = true;
                    status.message = 'Connexion réussie après attente post-clic';
                }
            }
        }

    } catch (error) {
        console.error('❌ Erreur :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
    }

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC', '-', status.message);
})();
