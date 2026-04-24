async function logoutSequence(account) {
    const { email, cookies, platform } = account;
    console.log(`🚪 Déconnexion pour ${email} via requête POST`);

    const proxyUrl = getProxyUrlForAccount(account);
    if (!proxyUrl) throw new Error('Aucun proxy fourni');

    let browser;
    try {
        const { browser: br, page } = await connectWithProxy(proxyUrl);
        browser = br;
        await page.setCookie(...cookies);

        // Aller sur la page du faucet pour récupérer le jeton CSRF
        await page.goto(`https://${platform}.io/faucet.php`, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);

        // Récupérer le jeton CSRF (cookie ou champ caché)
        const csrfToken = await page.evaluate(() => {
            const cookieValue = document.cookie.split('; ').find(row => row.startsWith('csrf_cookie_name='));
            if (cookieValue) return cookieValue.split('=')[1];
            const hiddenField = document.querySelector('input[name="csrf_test_name"]');
            if (hiddenField) return hiddenField.value;
            return null;
        });

        if (!csrfToken) {
            console.error('❌ Impossible de récupérer le jeton CSRF');
            await browser.close();
            return false;
        }
        console.log(`🔑 Jeton CSRF récupéré: ${csrfToken}`);

        // Construire les données POST
        const postData = new URLSearchParams();
        postData.append('action', 'logout');
        postData.append('csrf_test_name', csrfToken);

        // Envoyer la requête POST
        const response = await page.evaluate(async (data) => {
            const res = await fetch('/process.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: data
            });
            const text = await res.text();
            try {
                return { status: res.status, json: JSON.parse(text) };
            } catch (e) {
                return { status: res.status, text: text };
            }
        }, postData.toString());

        console.log(`📡 Réponse du serveur: status ${response.status}`);

        if (response.status === 200 && response.json && response.json.ret === 1) {
            console.log('✅ Déconnexion confirmée par le serveur');
            await browser.close();
            return true;
        } else if (response.status === 200 && response.json && response.json.ret !== 1) {
            console.log(`❌ Réponse du serveur: ret=${response.json.ret}, message="${response.json.mes}"`);
        } else {
            console.log(`❌ Réponse inattendue: ${response.text || 'pas de JSON'}`);
        }
        await browser.close();
        return false;
    } catch (error) {
        if (browser) await browser.close();
        console.error(`❌ Erreur lors de la déconnexion : ${error.message}`);
        return false;
    }
}
