const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

// --- Paramètres par défaut (utilisés si aucun proxy spécifié) ---
const DEFAULT_PROXY_HOST = '31.59.20.176';
const DEFAULT_PROXY_PORT = '6754';
const DEFAULT_PROXY_USERNAME = process.env.PROXY_USERNAME;
const DEFAULT_PROXY_PASSWORD = process.env.PROXY_PASSWORD;

// Coordonnées fixes (résolution 1280x720)
const TURNSTILE_COORDS = { x: 640, y: 195 };
const CLAIM_COORDS = { x: 640, y: 223 };

const outputDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions utilitaires (fillField, humanScrollToClaim, humanClickAt, etc.) inchangées ---
// [ Insérez ici toutes vos fonctions existantes : fillField, login (à adapter), humanScrollToClaim, humanClickAt, etc. ]
// Note : la fonction login doit prendre en paramètres l'email, le mot de passe, et éventuellement le proxy.

// --- Nouvelle fonction pour traiter un compte ---
async function processAccount(browser, account, index) {
    const { email, password, interval, site, proxy, enabled } = account;
    if (enabled === false) {
        console.log(`⏭️ Compte ${email} désactivé, ignoré.`);
        return { email, success: false, message: 'Désactivé' };
    }

    console.log(`\n===== 🤖 Traitement du compte ${index+1} : ${email} (${site}) =====`);

    // Déterminer l'URL du faucet selon le site
    const siteUrls = {
        tronpick: 'https://tronpick.io/faucet.php',
        litepick: 'https://litepick.io/faucet.php',
        dogepick: 'https://dogepick.io/faucet.php',
        solpick: 'https://solpick.io/faucet.php',
        binpick: 'https://binpick.io/faucet.php'
    };
    const faucetUrl = siteUrls[site] || 'https://tronpick.io/faucet.php';
    const loginUrl = faucetUrl.replace('/faucet.php', '/login.php');

    // Configurer le proxy pour ce compte (si spécifié)
    let proxyConfig = null;
    if (proxy) {
        const parts = proxy.split(':');
        if (parts.length === 2) {
            proxyConfig = { host: parts[0], port: parts[1] };
        } else if (parts.length === 4) {
            proxyConfig = { host: parts[0], port: parts[1], username: parts[2], password: parts[3] };
        }
    }
    // Si pas de proxy spécifié, on utilisera celui par défaut (passé via connect)

    // Créer un contexte de navigation privé pour ce compte
    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();
    
    // Si un proxy spécifique est défini, il faut l'authentifier
    if (proxyConfig && proxyConfig.username) {
        await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
    }

    try {
        // --- LOGIN ---
        console.log(`🌐 Accès login ${site}...`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        await fillField(page, 'input[type="email"], input[name="email"]', email, 'email');
        await fillField(page, 'input[type="password"]', password, 'password');
        await delay(2000);

        // Gestion Turnstile login (similaire à avant)
        try {
            const frame = await page.waitForFrame(f => f.url().includes('challenges.cloudflare.com/turnstile'), { timeout: 30000 });
            console.log('✅ Turnstile login présent, clic...');
            await frame.click('input[type="checkbox"]');
            await delay(5000);
        } catch (e) {}

        console.log('🔐 Clic sur "Log in"...');
        const loginClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const loginBtn = btns.find(b => b.textContent.trim() === 'Log in');
            if (loginBtn) { loginBtn.click(); return true; }
            return false;
        });
        if (!loginClicked) throw new Error('Bouton Log in introuvable');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
        await delay(5000);
        if (page.url().includes('login.php')) throw new Error('Échec connexion');
        console.log('✅ Connecté');

        // --- FAUCET ---
        console.log(`🚰 Accès faucet...`);
        await page.goto(faucetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(10000);

        // Attendre et scroller (réutiliser votre logique)
        await humanScrollToClaim(page);
        await delay(2000);

        // Clics Turnstile
        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 1/2');
        await delay(10000);
        await humanClickAt(page, TURNSTILE_COORDS, 'Turnstile 2/2');
        await delay(10000);
        await delay(10000); // attente avant claim

        await humanClickAt(page, CLAIM_COORDS, 'CLAIM');
        await page.waitForNetworkIdle({ timeout: 20000 }).catch(() => {});
        await delay(5000);

        // Vérifier succès
        const messages = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[class*="toast"], [class*="alert"], [role="alert"]'))
                .map(el => el.textContent.trim()).filter(t => t);
        });
        const btnDisabled = await page.evaluate(() => {
            return document.querySelector('#process_claim_hourly_faucet')?.disabled || false;
        });
        const success = btnDisabled || messages.some(m => /success|claimed|reward|sent/i.test(m));
        
        return { email, success, message: messages[0] || (btnDisabled ? 'Bouton désactivé' : 'Aucune réaction') };

    } catch (error) {
        console.error(`❌ Erreur pour ${email}:`, error);
        return { email, success: false, message: error.message };
    } finally {
        await context.close();
    }
}

// --- Fonction principale ---
(async () => {
    let browser;
    const results = [];
    try {
        // Lire le fichier accounts.json
        const accountsPath = path.join(__dirname, 'accounts.json');
        if (!fs.existsSync(accountsPath)) {
            console.log('❌ Fichier accounts.json introuvable.');
            return;
        }
        const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        if (accounts.length === 0) {
            console.log('ℹ️ Aucun compte configuré.');
            return;
        }

        console.log(`🚀 Lancement pour ${accounts.length} compte(s)`);

        // Lancer UN navigateur avec le proxy par défaut
        const { browser: br } = await connect({
            headless: false,
            turnstile: true,
            proxy: { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD }
        });
        browser = br;

        for (let i = 0; i < accounts.length; i++) {
            const result = await processAccount(browser, accounts[i], i);
            results.push(result);
            await delay(5000); // pause entre comptes
        }

        console.log('📊 Résultats finaux :', results);
        
        // Sauvegarder les résultats dans status.json
        const statusPath = path.join(__dirname, 'public', 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify(results, null, 2));

    } catch (e) {
        console.error('❌ Erreur fatale :', e);
    } finally {
        if (browser) await browser.close();
    }
})();
