name: Claim Tronpick Faucet

on:
  schedule:
    # Exécution à la minute 0 de chaque heure, tous les jours
    - cron: '0 * * * *'
  workflow_dispatch:   # Permet de lancer manuellement si besoin

jobs:
  claim:
    runs-on: ubuntu-latest
    steps:
      - name: 📥 Récupérer le code source
        uses: actions/checkout@v4

      - name: 🟢 Installer Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 📦 Installer les dépendances système (xvfb)
        run: |
          sudo apt-get update
          sudo apt-get install -y xvfb

      - name: 📦 Installer les dépendances Node.js
        run: npm install

      - name: 🤖 Exécuter le script avec xvfb
        env:
          TRONPICK_EMAIL: ${{ secrets.TRONPICK_EMAIL }}
          TRONPICK_PASSWORD: ${{ secrets.TRONPICK_PASSWORD }}
          PROXY_USERNAME: ${{ secrets.PROXY_USERNAME }}
          PROXY_PASSWORD: ${{ secrets.PROXY_PASSWORD }}
        run: xvfb-run --auto-servernum --server-args="-screen 0 1280x720x24" node script.js

      - name: 📤 Upload des captures d'écran (artefacts)
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: faucet-screenshots
          path: screenshots/

      - name: 📝 Commiter le statut
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add public/status.json
          git diff --quiet && git diff --staged --quiet || (git commit -m "🔄 Update status [skip ci]" && git push)
