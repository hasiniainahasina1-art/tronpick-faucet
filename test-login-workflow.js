const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');

const email = process.env.TEST_EMAIL;
const password = process.env.TEST_PASSWORD;
const platform = process.env.TEST_PLATFORM;
const proxyIndex = process.env.TEST_PROXY_INDEX !== '' ? parseInt(process.env.TEST_PROXY_INDEX) : undefined;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH;
const GH_FILE_PATH = process.env.GH_FILE_PATH;
const JP_PROXY_LIST = (process.env.JP_PROXY_LIST || '').split(',').filter(p => p.trim() !== '');

async function run() {
  let browser;
  try {
    // Sélection du proxy
    let proxyUrl = JP_PROXY_LIST[0];
    if (proxyIndex !== undefined && JP_PROXY_LIST[proxyIndex]) {
      proxyUrl = JP_PROXY_LIST[proxyIndex];
    }
    console.log(`🔄 Proxy utilisé : ${proxyUrl}`);

    const { browser: br, page } = await connect({
      headless: false,
      turnstile: true,
      proxy: proxyUrl
    });
    browser = br;

    const loginUrl = `https://${platform}.io/login.php`;
    console.log(`🌐 Connexion à ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', email);
    await page.type('input[type="password"]', password);
    await page.click('button:contains("Log in")');
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});

    const success = !page.url().includes('login.php');
    const cookies = success ? await page.cookies() : [];
    const errorMsg = success ? null : await page.evaluate(() => {
      const el = document.querySelector('.alert-danger, .error');
      return el ? el.innerText : 'Login failed';
    });

    await browser.close();

    // Mise à jour de accounts.json
    const octokit = new Octokit({ auth: GH_TOKEN });
    let accounts = [];
    try {
      const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
      accounts = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
    } catch (e) {}

    const existingIndex = accounts.findIndex(a => a.email === email);
    const newAccount = {
      email,
      password,
      platform,
      proxy: proxyUrl,
      enabled: true,
      cookies: success ? cookies : [],
      cookiesStatus: success ? 'valid' : 'failed',
      lastClaim: success ? Date.now() : 0,
      timer: 60,
      proxyIndex: proxyIndex !== undefined ? proxyIndex : 0
    };
    if (existingIndex !== -1) accounts[existingIndex] = newAccount;
    else accounts.push(newAccount);

    const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
    let sha = null;
    try {
      const res = await octokit.repos.getContent({ owner: GH_USERNAME, repo: GH_REPO, path: GH_FILE_PATH, ref: GH_BRANCH });
      sha = res.data.sha;
    } catch (e) {}
    await octokit.repos.createOrUpdateFileContents({
      owner: GH_USERNAME,
      repo: GH_REPO,
      path: GH_FILE_PATH,
      message: `Test login for ${email} - ${success ? 'success' : 'failed'}`,
      content,
      branch: GH_BRANCH,
      sha
    });

    console.log(`✅ Résultat : ${success ? 'Succès' : 'Échec : ' + errorMsg}`);
    process.exit(success ? 0 : 1);
  } catch (err) {
    if (browser) await browser.close();
    console.error('❌ Erreur :', err);
    process.exit(1);
  }
}
run();
