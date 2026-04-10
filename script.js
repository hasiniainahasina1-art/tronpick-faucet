// --- LOGIN PAGE ---
console.log('🌐 Accès login...');
await page.goto('https://tronpick.io/login.php', { waitUntil: 'networkidle2', timeout: 30000 });
await humanDelay(1000, 2000);

// Vérification et saisie email
const emailSelector = 'input[type="email"], input[name="email"], input#email';
await page.waitForSelector(emailSelector, { timeout: 10000 });
await page.type(emailSelector, EMAIL, { delay: 50 });
const typedEmail = await page.$eval(emailSelector, el => el.value);
console.log('📧 Email saisi :', typedEmail);

// Vérification et saisie mot de passe
const passwordSelector = 'input[type="password"], input[name="password"], input#password';
await page.type(passwordSelector, PASSWORD, { delay: 50 });
const typedPassword = await page.$eval(passwordSelector, el => el.value.length);
console.log('🔑 Longueur mot de passe saisi :', typedPassword);

// Pause pour Turnstile
console.log('⏳ Pause de 10 secondes pour validation Turnstile...');
await delay(10000);

// --- CLIQUER SUR LOGIN ---
console.log('🔐 Clic sur bouton "Log in"...');
await page.click('button[type="submit"], button.btn-primary');

// --- ATTENTE NAVIGATION ---
try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('✅ Navigation détectée après login');
} catch (e) {
    console.log('⚠️ Pas de navigation, on attend réseau inactif');
    await waitForNetworkIdle(page, 15000);
}

// Vérification connexion
const loggedIn = await isLoggedIn(page);
if (loggedIn) {
    status.success = true;
    status.message = 'Connexion réussie !';
    console.log('✅ Connexion réussie !');
} else {
    const errorMsg = await getErrorMessage(page);
    if (errorMsg) {
        console.log('❌ Message d\'erreur détecté :', errorMsg);
        status.message = `Échec: ${errorMsg}`;
    } else {
        status.message = 'Échec de connexion (pas de message d\'erreur visible)';
        console.log('❌', status.message);
    }
}
