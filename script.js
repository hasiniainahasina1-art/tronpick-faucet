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

        // ------------------- LOGIN -------------------
        console.log('🌐 Accès à la page de login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   URL actuelle :', page.url());

        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 15000, visible: true });
        console.log('✅ Champ email détecté');

        console.log('⌨️ Saisie des identifiants...');
        await page.type(emailSelector, EMAIL, { delay: 50 });
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 50 });

        // Recherche EXACTE du bouton "Log in"
        console.log('🔍 Recherche du bouton "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });

        if (!loginButton) {
            throw new Error('Bouton "Log in" introuvable');
        }

        console.log('🔐 Clic sur "Log in"...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(e => console.log('⚠️ Timeout navigation :', e.message)),
            loginButton.click()
        ]);

        await page.waitForTimeout(3000);
        console.log('   URL après connexion :', page.url());

        if (page.url().includes('login.php')) {
            throw new Error('Échec de connexion : toujours sur login.php');
        }
        console.log('✅ Connexion réussie !');

        // ------------------- FAUCET -------------------
        console.log('🚰 Accès à la page faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   URL faucet :', page.url());

        // Attendre 15 secondes pour chargement complet
        console.log('⏳ Attente de 15 secondes...');
        await page.waitForTimeout(15000);

        // ------------------- RECHERCHE ET CLIC SUR CLAIM -------------------
        console.log('\n🎯 Recherche du bouton CLAIM...');
        let claimClicked = false;

        const clickClaimInFrame = async (frame) => {
            try {
                return await frame.evaluate(() => {
                    const keywords = ['claim', 'get', 'receive', 'roll', 'withdraw', 'collect', 'free', 'claim now', 'get reward'];
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
                return { clicked: false };
            }
        };

        // Essayer page principale
        const mainClick = await clickClaimInFrame(page.mainFrame());
        if (mainClick.clicked) {
            console.log(`✅ CLAIM cliqué (page principale) : "${mainClick.text}"`);
            claimClicked = true;
        } else {
            const frames = page.frames();
            for (let i = 1; i < frames.length; i++) {
                const frameClick = await clickClaimInFrame(frames[i]);
                if (frameClick.clicked) {
                    console.log(`✅ CLAIM cliqué (iframe ${i}) : "${frameClick.text}"`);
                    claimClicked = true;
                    break;
                }
            }
        }

        if (!claimClicked) {
            console.log('❌ Bouton CLAIM non trouvé. Liste des éléments visibles :');
            const visibleElements = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
                    .filter(el => el.offsetParent !== null)
                    .map(el => ({ tag: el.tagName, text: (el.textContent || el.value || '').trim().substring(0, 40) }));
            });
            console.log(JSON.stringify(visibleElements, null, 2));
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

    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré');
})();
