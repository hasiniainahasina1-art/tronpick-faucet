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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const humanDelay = async (min = 500, max = 2000) => {
    await delay(Math.floor(Math.random() * (max - min) + min));
};

// Nouvelle fonction pour attendre que le frame principal soit prêt
async function waitForMainFrameStable(page, maxAttempts = 5) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            // Vérifier que le frame principal est accessible
            const mainFrame = page.mainFrame();
            await mainFrame.evaluate(() => document.readyState);
            console.log('✅ Frame principal stable');
            return mainFrame;
        } catch (e) {
            console.log(`⏳ Frame principal pas encore prêt (tentative ${i + 1}/${maxAttempts})`);
            await delay(1000);
        }
    }
    throw new Error('Frame principal inaccessible après plusieurs tentatives');
}

// Recherche de l'iframe Turnstile avec retry
async function findTurnstileFrame(page, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame.url().includes('challenges.cloudflare.com') && frame.url().includes('turnstile')) {
                console.log(`✅ Iframe Turnstile trouvée`);
                return frame;
            }
        }
        await delay(1000);
    }
    return null;
}

// Clic sur la case Turnstile
async function clickTurnstileCheckbox(frame) {
    console.log('🔍 Recherche de la case Turnstile dans l\'iframe...');
    
    try {
        await frame.waitForSelector('body', { timeout: 10000 });
    } catch (e) {
        console.log('⚠️ Body non trouvé dans l\'iframe');
    }

    const clicked = await frame.evaluate(() => {
        // Essayer plusieurs sélecteurs
        const selectors = [
            "//label[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'vérifier que vous êtes humain')]",
            'input[type="checkbox"]',
            '.challenge-container input[type="checkbox"]',
            'label',
            'div[role="checkbox"]'
        ];

        for (const sel of selectors) {
            try {
                let el;
                if (sel.startsWith('//')) {
                    el = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                } else {
                    el = document.querySelector(sel);
                }
                if (el && el.offsetParent !== null) {
                    el.click();
                    return { success: true, method: sel };
                }
            } catch (e) {}
        }

        // Dernier recours : cliquer au centre
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const element = document.elementFromPoint(centerX, centerY);
        if (element) {
            element.click();
            return { success: true, method: 'center click' };
        }

        return { success: false };
    });

    if (clicked.success) {
        console.log(`✅ Clic effectué (${clicked.method})`);
    } else {
        console.log('❌ Impossible de cliquer sur la case Turnstile');
    }
    return clicked.success;
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

        // --- LOGIN PAGE ---
        console.log('🌐 Accès à login.php...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });

        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.type(emailSelector, EMAIL, { delay: 30 });
        await humanDelay(300, 600);

        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 30 });
        await humanDelay(500, 1000);

        console.log('⏳ Attente de l\'injection de Turnstile...');
        await delay(3000);

        // --- RECHERCHE IFRAME TURNSTILE ---
        let turnstileFrame = await findTurnstileFrame(page);
        
        if (!turnstileFrame) {
            console.log('🔄 Turnstile non visible, tentative de focus...');
            await page.click('body', { offset: { x: 400, y: 400 } });
            turnstileFrame = await findTurnstileFrame(page);
        }

        if (!turnstileFrame) {
            console.log('⚠️ Iframe Turnstile introuvable, on tente le login directement');
        } else {
            // --- CLIQUER SUR LA CASE TURNSTILE ---
            console.log('🎯 Clic sur "Vérifier que vous êtes humain"...');
            await clickTurnstileCheckbox(turnstileFrame);
            
            // Attendre que Turnstile se résolve
            console.log('⏳ Attente de la validation Turnstile (max 20s)...');
            const startWait = Date.now();
            let turnstileValidated = false;
            while (Date.now() - startWait < 20000) {
                try {
                    const isChecked = await turnstileFrame.evaluate(() => {
                        const cb = document.querySelector('input[type="checkbox"]');
                        return cb ? cb.checked : false;
                    });
                    if (isChecked) {
                        console.log('✅ Turnstile coché !');
                        turnstileValidated = true;
                        break;
                    }
                } catch (e) {
                    // L'iframe a peut-être disparu (challenge résolu)
                    console.log('✅ Iframe disparue - Turnstile probablement résolu');
                    turnstileValidated = true;
                    break;
                }
                await delay(2000);
            }
            
            if (!turnstileValidated) {
                console.log('⚠️ Turnstile non résolu après attente');
            }
        }

        // --- ATTENDRE QUE LE FRAME PRINCIPAL SOIT STABLE ---
        console.log('🔍 Attente de la stabilité du frame principal...');
        const mainFrame = await waitForMainFrameStable(page);
        
        // Attendre que la page soit complètement chargée
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
        await delay(2000);

        // --- CLIQUER SUR LOGIN ---
        console.log('🔐 Recherche du bouton "Log in"...');
        
        // Utiliser waitForSelector pour être sûr que le bouton est présent
        const loginButtonSelector = 'button';
        await page.waitForSelector(loginButtonSelector, { timeout: 10000 });
        
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });

        if (!loginButton) {
            throw new Error('Bouton "Log in" introuvable');
        }

        console.log('🖱️ Clic sur "Log in"...');
        
        // Utiliser Promise.all avec un timeout plus long
        const navigationPromise = page.waitForNavigation({ 
            waitUntil: 'networkidle2', 
            timeout: 30000 
        }).catch(e => {
            console.log('⚠️ Navigation timeout:', e.message);
            return null;
        });
        
        await loginButton.click();
        await navigationPromise;
        
        // Attendre un peu après la navigation
        await delay(5000);
        
        const currentUrl = page.url();
        console.log('📍 URL après login :', currentUrl);
        
        if (!currentUrl.includes('login.php')) {
            status.success = true;
            status.message = 'Connexion réussie !';
        } else {
            // Vérifier les messages d'erreur
            const errorMsg = await page.evaluate(() => {
                const err = document.querySelector('.alert-danger, .error, .message-error');
                return err ? err.textContent.trim() : null;
            });
            status.message = errorMsg ? `Échec: ${errorMsg}` : 'Échec de connexion';
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
