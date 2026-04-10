const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');

// Vos identifiants, stockés en sécurité dans les secrets GitHub
const EMAIL = process.env.TRONPICK_EMAIL;
const PASSWORD = process.env.TRONPICK_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const PROXY_HOST = '31.59.20.176';
const PROXY_PORT = '6754';

if (!EMAIL || !PASSWORD || !PROXY_USERNAME || !PROXY_PASSWORD) {
    console.error('❌ Variables d\'environnement manquantes');
    process.exit(1);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    let browser;
    const status = { success: false, time: new Date().toISOString(), message: '' };

    try {
        console.log('🚀 Lancement du navigateur furtif...');
        
        // Connexion au navigateur avec puppeteer-real-browser
        const { browser: br, page } = await connect({
            headless: false, // Obligatoire pour puppeteer-real-browser
            turnstile: true,  // Active le clic automatique sur le défi Turnstile
            proxy: {          // Votre proxy résidentiel
                host: PROXY_HOST,
                port: PROXY_PORT,
                username: PROXY_USERNAME,
                password: PROXY_PASSWORD
            }
        });
        browser = br;
        console.log('✅ Proxy authentifié et navigateur prêt');

        // Gestion des popups
        page.on('dialog', async dialog => { await dialog.accept(); });
        await page.setViewport({ width: 1280, height: 720 });

        // --- PHASE DE CONNEXION AUTOMATIQUE ---
        console.log('🌐 Accès à la page de login...');
        await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 60000 });

        // Remplissage du formulaire
        console.log('⌨️ Remplissage des identifiants...');
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.type('input[type="email"]', EMAIL, { delay: 50 });
        await page.type('input[type="password"]', PASSWORD, { delay: 50 });
        await delay(2000);

        // Clic sur "Log in" (le Turnstile est géré automatiquement)
        console.log('🔐 Clic sur "Log in"...');
        const loginButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(btn => btn.textContent.trim() === 'Log in');
        });
        if (!loginButton) throw new Error('Bouton "Log in" introuvable');
        
        await loginButton.click();
        console.log('✅ Clic effectué, attente de la résolution automatique de Turnstile...');

        // La bibliothèque gère Turnstile : on attend juste que le réseau soit calme
        await page.waitForNetworkIdle({ timeout: 45000 });
        await delay(5000);

        const currentUrl = page.url();
        console.log('📍 URL après connexion :', currentUrl);

        if (currentUrl.includes('login.php')) {
            // ... (gestion d'erreur, similaire à avant)
            status.message = 'Échec de connexion (toujours sur login.php)';
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
        const statusPath = path.join(__dirname, 'public', 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
        console.log('📝 Statut enregistré :', status.success ? 'SUCCÈS' : 'ÉCHEC');
    }
})();
