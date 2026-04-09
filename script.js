const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Active le plugin stealth (indispensable pour masquer l'automatisation)
puppeteer.use(StealthPlugin());

// Récupération sécurisée des informations depuis les secrets GitHub
const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '198.23.239.134';
const PROXY_PORT = '6540';

// Vérification que toutes les variables sont présentes
if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

// Petite fonction pour faire des pauses aléatoires (simule un humain)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const humanDelay = async (min = 500, max = 2000) => {
    const ms = Math.floor(Math.random() * (max - min) + min);
    await delay(ms);
};

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
            headless: false, // Doit être false pour passer les défis Cloudflare
            args: [
                '--disable-blink-features=AutomationControlled',
                `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`
            ]
        });

        const page = await browser.newPage();

        // Authentification auprès du proxy
        await page.authenticate({
            username: PROXY_USERNAME,
            password: PROXY_PASSWORD
        });
        console.log('✅ Proxy authentifié');

        // Gestion des boîtes de dialogue (alertes)
        page.on('dialog', async dialog => {
            console.log('📢 Alerte :', dialog.message());
            await dialog.accept();
        });

        // Configuration de la vue et de l'user-agent
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // --- ETAPE 1 : ACCES A LA PAGE DE LOGIN ---
        console.log('🌐 Accès à la page de login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await humanDelay(1000, 2000);

        // --- ETAPE 2 : REMPLISSAGE DES CHAMPS ---
        console.log('⌨️ Remplissage des identifiants...');
        const emailSelector = 'input[type="email"], input[name="email"], input#email';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.type(emailSelector, EMAIL, { delay: 50 });
        await humanDelay(300, 600);

        const passwordSelector = 'input[type="password"], input[name="password"], input#password';
        await page.type(passwordSelector, PASSWORD, { delay: 50 });
        await humanDelay(500, 1000);

        // --- ETAPE 3 : ATTENDRE ET INTERAGIR AVEC TURNSTILE (si présent) ---
        console.log('⏳ Attente de l\'apparition éventuelle de Turnstile...');
        await delay(5000);

        // Vérifier si une iframe Turnstile est présente
        const turnstileFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com/turnstile'));
        if (turnstileFrame) {
            console.log('🛡️ Turnstile détecté. Tentative de clic automatique...');
            try {
                // Attendre que le widget soit chargé dans l'iframe
                await turnstileFrame.waitForSelector('body', { timeout: 5000 });
                // Clic sur la case à cocher
                await turnstileFrame.click('input[type="checkbox"]');
                console.log('✅ Clic sur la case Turnstile effectué');
                // Attendre la validation (max 20s)
                await delay(20000);
            } catch (e) {
                console.log('⚠️ Interaction Turnstile échouée, on tente la connexion directe.');
            }
        } else {
            console.log('✅ Aucun Turnstile visible pour le moment.');
        }

        // --- ETAPE 4 : CLIQUER SUR LE BOUTON LOGIN ---
        console.log('🔐 Recherche du bouton "Log in"...');
        // Utiliser une fonction evaluate pour trouver le bouton par son texte exact
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });

        if (!loginButton) {
            throw new Error('Bouton "Log in" introuvable');
        }

        // Clic et attente de navigation
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => {
                console.log('⚠️ Navigation timeout :', e.message);
            }),
            loginButton.click()
        ]);

        await delay(5000);
        const currentUrl = page.url();
        console.log('📍 URL après connexion :', currentUrl);

        // Vérification du succès de la connexion
        if (currentUrl.includes('login.php')) {
            // Vérifier les messages d'erreur
            const errorMsg = await page.evaluate(() => {
                const err = document.querySelector('.alert-danger, .error, .message-error');
                return err ? err.textContent.trim() : null;
            });
            status.message = errorMsg ? `Échec: ${errorMsg}` : 'Échec de connexion (toujours sur login.php)';
            console.log('❌', status.message);
        } else {
            status.success = true;
            status.message = 'Connexion réussie !';
            console.log('✅ Connexion réussie !');
        }

    } catch (error) {
        console.error('❌ Erreur fatale :', error);
        status.message = error.message;
    } finally {
        if (browser) await browser.close();
    }

    // Écriture du statut dans le fichier pour l'affichage sur Vercel
    const statusPath = path.join(__dirname, 'public', 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC');
})();
