// script.js
const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');

// --- Configuration GitHub (dépôt) ---
const GH_TOKEN = process.env.GH_TOKEN;
const GH_USERNAME = process.env.GH_USERNAME;
const GH_REPO = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_FILE_PATH = process.env.GH_FILE_PATH || 'accounts.json';

if (!GH_TOKEN || !GH_USERNAME || !GH_REPO) {
    console.error('❌ Variables GitHub manquantes');
    process.exit(1);
}

const octokit = new Octokit({ auth: GH_TOKEN });

// --- Proxy par défaut ---
const DEFAULT_PROXY_HOST = '31.59.20.176';
const DEFAULT_PROXY_PORT = '6754';
const DEFAULT_PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const DEFAULT_PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

// --- Coordonnées fixes (1280x720) ---
const TURNSTILE_COORDS = { x: 640, y: 615 };
const CLAIM_COORDS = { x: 640, y: 223 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Fonctions utilitaires (fillField, humanScrollToClaim, humanClickAt) ---
// [Recopiez-les exactement depuis les versions précédentes]

// --- Gestion du dépôt GitHub ---
async function loadAccounts() {
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            ref: GH_BRANCH
        });
        return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    } catch (e) {
        if (e.status === 404) return [];
        throw e;
    }
}

async function saveAccounts(accounts) {
    let sha = null;
    try {
        const res = await octokit.repos.getContent({
            owner: GH_USERNAME,
            repo: GH_REPO,
            path: GH_FILE_PATH,
            ref: GH_BRANCH
        });
        sha = res.data.sha;
    } catch (e) {}
    const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
        owner: GH_USERNAME,
        repo: GH_REPO,
        path: GH_FILE_PATH,
        message: 'Mise à jour automatique',
        content,
        branch: GH_BRANCH,
        sha
    });
}

// --- Login et capture cookies (identique à avant) ---
// [Recopiez performLoginAndCaptureCookies]

// --- Claim avec cookies (identique à avant) ---
// [Recopiez claimWithCookies]

// --- Principal ---
(async () => {
    let browser;
    try {
        let accounts = await loadAccounts();
        console.log(`📋 Comptes chargés : ${accounts.length}`);

        if (!accounts.length) {
            console.log('Aucun compte.');
            return;
        }

        const now = Date.now();
        let needsSave = false;

        // 1. Capturer cookies pour les comptes pending
        const pending = accounts.filter(acc => acc.enabled && !acc.cookies);
        if (pending.length) {
            console.log(`🍪 Capture cookies pour ${pending.length} compte(s)...`);
            const { browser: br } = await connect({
                headless: false,
                turnstile: true,
                proxy: { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD }
            });
            browser = br;

            for (const acc of pending) {
                try {
                    const cookies = await performLoginAndCaptureCookies(browser, acc);
                    acc.cookies = cookies;
                    acc.cookiesStatus = 'valid';
                    console.log(`✅ Cookies OK pour ${acc.email}`);
                } catch (e) {
                    acc.cookiesStatus = 'failed';
                    console.log(`❌ Échec login ${acc.email}: ${e.message}`);
                }
                needsSave = true;
                await delay(5000);
            }
            await browser.close();
            browser = null;
        }

        // 2. Claim pour les comptes valides
        const eligible = accounts.filter(acc => {
            if (!acc.enabled || !acc.cookies || acc.cookiesStatus !== 'valid') return false;
            const last = acc.lastClaim || 0;
            return (now - last) >= (acc.timer || 60) * 60 * 1000;
        });

        if (eligible.length) {
            console.log(`🚀 Claim pour ${eligible.length} compte(s)...`);
            const { browser: br } = await connect({
                headless: false,
                turnstile: true,
                proxy: { host: DEFAULT_PROXY_HOST, port: DEFAULT_PROXY_PORT, username: DEFAULT_PROXY_USERNAME, password: DEFAULT_PROXY_PASSWORD }
            });
            browser = br;

            for (const acc of eligible) {
                try {
                    const result = await claimWithCookies(browser, acc);
                    if (result.success) {
                        acc.lastClaim = now;
                        console.log(`✅ Claim réussi pour ${acc.email}`);
                    } else {
                        console.log(`❌ Claim échoué pour ${acc.email}: ${result.message}`);
                    }
                } catch (e) {
                    console.error(`❌ Erreur claim ${acc.email}:`, e.message);
                    if (e.message.includes('expir')) {
                        acc.cookies = null;
                        acc.cookiesStatus = 'expired';
                    }
                }
                needsSave = true;
                await delay(5000);
            }
            await browser.close();
        }

        if (needsSave) {
            await saveAccounts(accounts);
            console.log('💾 Comptes sauvegardés.');
        }

    } catch (e) {
        console.error('Erreur fatale:', e);
    } finally {
        if (browser) await browser.close();
    }
})();
