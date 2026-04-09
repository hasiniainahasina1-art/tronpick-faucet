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

// Fonction pour explorer récursivement toutes les frames
async function exploreAllFrames(frame, depth = 0) {
    const indent = '  '.repeat(depth);
    console.log(`${indent}🌐 Frame ${depth}: ${frame.url().substring(0, 80)}`);
    try {
        // Lister les éléments cliquables dans cette frame
        const elements = await frame.evaluate(() => {
            const els = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"], [onclick]'));
            return els.map(el => ({
                tag: el.tagName,
                text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().substring(0, 60),
                disabled: el.disabled || false,
                visible: el.offsetParent !== null
            }));
        });
        elements.filter(el => el.visible).forEach(el => {
            console.log(`${indent}   🔘 [${el.tag}] "${el.text}" ${el.disabled ? '(DÉSACTIVÉ)' : ''}`);
        });
    } catch (e) {
        console.log(`${indent}   ❌ Frame inaccessible (cross-origin)`);
    }

    // Parcourir les frames enfants
    const childFrames = frame.childFrames();
    for (const child of childFrames) {
        await exploreAllFrames(child, depth + 1);
    }
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

        // --- LOGIN ---
        console.log('🌐 Connexion...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
        await page.type('input[type="email"]', EMAIL, { delay: 30 });
        await page.type('input[type="password"]', PASSWORD, { delay: 30 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            page.keyboard.press('Enter')
        ]);
        await page.waitForTimeout(4000);

        // --- FAUCET ---
        console.log('🚰 Accès faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });

        // Attendre 20 secondes pour être sûr que tout est chargé
        console.log('⏳ Attente de 20 secondes pour le chargement complet...');
        await page.waitForTimeout(20000);

        // --- EXPLORATION DES FRAMES ---
        console.log('\n🔍 ÉLÉMENTS CLIQUABLES TROUVÉS :');
        await exploreAllFrames(page.mainFrame());

        // --- CAPTURE D'ÉCRAN ---
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        console.log('\n📸 CAPTURE_BASE64_START');
        console.log(screenshot);
        console.log('📸 CAPTURE_BASE64_END');

        // --- TENTATIVE DE CLIC AVANCÉE ---
        console.log('\n🎯 Tentative de clic sur le bouton CLAIM...');
        let claimClicked = false;

        // Fonction pour cliquer dans une frame donnée
        const clickInFrame = async (frame) => {
            try {
                return await frame.evaluate(() => {
                    const keywords = ['claim', 'get', 'receive', 'roll', 'withdraw', 'collect', 'free'];
                    const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"], span[role="button"]'));
                    for (const el of elements) {
                        const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                        if (keywords.some(kw => text.includes(kw)) && !el.disabled && el.offsetParent !== null) {
                            el.click();
                            return { clicked: true, text: text };
                        }
                    }
                    return { clicked: false };
                });
            } catch (e) {
                return { clicked: false, error: e.message };
            }
        };

        // Essayer la frame principale
        const mainClick = await clickInFrame(page.mainFrame());
        if (mainClick.clicked) {
            console.log(`✅ CLAIM cliqué (page principale) : "${mainClick.text}"`);
            claimClicked = true;
        } else {
            // Essayer toutes les iframes
            const frames = page.frames();
            for (let i = 1; i < frames.length; i++) {
                const frameClick = await clickInFrame(frames[i]);
                if (frameClick.clicked) {
                    console.log(`✅ CLAIM cliqué (iframe ${i}) : "${frameClick.text}"`);
                    claimClicked = true;
                    break;
                }
            }
        }

        if (!claimClicked) {
            console.log('❌ Aucun bouton CLAIM trouvé ou clicable.');
            status.message = 'Bouton CLAIM introuvable';
        } else {
            await page.waitForTimeout(5000);
            status.message = 'CLAIM cliqué avec succès';
        }

        status.success = claimClicked;

    } catch (error) {
        console.error('❌ Erreur :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
    }

    // Sauvegarde du statut
    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré');
})();
