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

        // Attendre que le champ email soit présent et visible
        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 15000, visible: true });
        console.log('✅ Champ email détecté et visible');

        // Saisie des identifiants avec un délai humain
        console.log('⌨️ Saisie des identifiants...');
        await page.type(emailSelector, EMAIL, { delay: 50 });
        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 50 });

        // Récupérer les sélecteurs de bouton de connexion possibles
        const loginButtonSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'form button',
            'form input[type="submit"]',
            'button:contains("Login")',   // Ne fonctionne pas avec Puppeteer, mais on gère via JS
        ];

        let loginSuccess = false;

        // Essayer d'abord les sélecteurs CSS simples
        for (const sel of loginButtonSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    console.log(`   Tentative de clic avec sélecteur : ${sel}`);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(e => console.log('   Navigation timeout ou erreur :', e.message)),
                        btn.click()
                    ]);
                    await page.waitForTimeout(3000);
                    console.log('   URL après tentative :', page.url());
                    if (!page.url().includes('login.php') && !page.url().includes('login')) {
                        loginSuccess = true;
                        console.log('✅ Connexion réussie !');
                        break;
                    }
                }
            } catch (e) {
                console.log(`   Échec avec ${sel} :`, e.message);
            }
        }

        // Si toujours pas connecté, recherche par texte avec evaluate
        if (!loginSuccess) {
            console.log('🔄 Recherche du bouton par texte...');
            const clicked = await page.evaluate(() => {
                const keywords = ['login', 'sign in', 'connexion', 'se connecter', 'enter'];
                const elements = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
                for (const el of elements) {
                    const text = (el.textContent || el.value || '').toLowerCase();
                    if (keywords.some(kw => text.includes(kw))) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });
            if (clicked) {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
                await page.waitForTimeout(3000);
                console.log('   URL après clic texte :', page.url());
                if (!page.url().includes('login.php')) {
                    loginSuccess = true;
                    console.log('✅ Connexion réussie via texte !');
                }
            }
        }

        // Dernière chance : touche Entrée
        if (!loginSuccess) {
            console.log('⌨️ Tentative avec touche Entrée...');
            await page.focus(passwordSelector);
            await page.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(3000);
            console.log('   URL après Entrée :', page.url());
            if (!page.url().includes('login.php')) {
                loginSuccess = true;
                console.log('✅ Connexion réussie via Entrée !');
            }
        }

        if (!loginSuccess) {
            throw new Error('ÉCHEC DE CONNEXION : Impossible de se connecter après plusieurs tentatives.');
        }

        // ------------------- FAUCET -------------------
        console.log('🚰 Accès à la page faucet...');
        await page.goto('https://tronpick.io/faucet.php', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('   URL faucet :', page.url());

        // Attendre 20 secondes pour le chargement complet
        console.log('⏳ Attente de 20 secondes...');
        await page.waitForTimeout(20000);

        // ------------------- RECHERCHE DU BOUTON CLAIM -------------------
        console.log('\n🔍 ÉLÉMENTS CLIQUABLES TROUVÉS :');
        // Explorer les frames comme précédemment
        async function exploreFrames(frame, depth = 0) {
            const indent = '  '.repeat(depth);
            console.log(`${indent}🌐 Frame ${depth}: ${frame.url().substring(0, 80)}`);
            try {
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
                console.log(`${indent}   ❌ Frame inaccessible`);
            }
            const children = frame.childFrames();
            for (const child of children) {
                await exploreFrames(child, depth + 1);
            }
        }
        await exploreFrames(page.mainFrame());

        // Tentative de clic sur CLAIM
        let claimClicked = false;
        const clickInFrame = async (frame) => {
            try {
                return await frame.evaluate(() => {
                    const kw = ['claim', 'get', 'receive', 'roll', 'withdraw', 'collect', 'free'];
                    const els = Array.from(document.querySelectorAll('button, input[type="submit"], a, div[role="button"]'));
                    for (const el of els) {
                        const txt = (el.textContent || el.value || '').toLowerCase();
                        if (kw.some(k => txt.includes(k)) && !el.disabled && el.offsetParent !== null) {
                            el.click();
                            return { clicked: true, text: txt };
                        }
                    }
                    return { clicked: false };
                });
            } catch (e) {
                return { clicked: false };
            }
        };

        const mainClick = await clickInFrame(page.mainFrame());
        if (mainClick.clicked) {
            console.log(`✅ CLAIM cliqué (page principale) : "${mainClick.text}"`);
            claimClicked = true;
        } else {
            const frames = page.frames();
            for (let i = 1; i < frames.length; i++) {
                const fClick = await clickInFrame(frames[i]);
                if (fClick.clicked) {
                    console.log(`✅ CLAIM cliqué (iframe ${i}) : "${fClick.text}"`);
                    claimClicked = true;
                    break;
                }
            }
        }

        if (!claimClicked) {
            console.log('❌ Aucun bouton CLAIM trouvé.');
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
