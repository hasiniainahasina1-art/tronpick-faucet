export default function handler(req, res) {
    res.status(200).json({
        GH_TOKEN: process.env.GH_TOKEN ? 'défini' : 'manquant',
        GH_USERNAME: process.env.GH_USERNAME || null,
        GH_REPO: process.env.GH_REPO || null
    });
}
