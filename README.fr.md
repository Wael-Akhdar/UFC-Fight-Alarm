# ⏰ UFC Réveil

Dors tranquille : ton téléphone sonne quand ton combat UFC arrive.

Site : **https://ufc-reveil.ufc-reveil.workers.dev**

Le site suit la carte en direct (API publique d'ESPN). L'alarme sonne **dès que le combat juste avant le tien est terminé**, environ 10 min avant les walkouts.

## Comment ça marche

1. Ouvre le site sur ton téléphone et suis le guide « Avant de dormir », avec un onglet iPhone et un onglet Samsung/Android.
2. Choisis ton combat → « ⏰ Me réveiller » → « Activer le réveil ici ».
3. Branche le téléphone et laisse la page ouverte. L'écran passe en noir avec l'heure.
4. Quand le combat d'avant se termine, une alarme sonne en boucle, avec l'écran qui clignote, jusqu'à ce que tu appuies sur STOP.

Le son passe par le lecteur média du navigateur, donc il sonne **même en silencieux et en Ne pas déranger**.
La limite : la page doit rester ouverte et l'écran allumé. Si le téléphone se verrouille, le navigateur met la page en pause.

### Réglages importants

| | iPhone | Samsung |
|---|---|---|
| Écran toujours allumé | Réglages → Luminosité et affichage → Verrouillage automatique → **Jamais** | La page le fait seule (Chrome / Samsung Internet). En plus : Paramètres → Affichage → Mise en veille de l'écran → 10 minutes |
| Économie d'énergie | Réglages → Batterie → Mode économie d'énergie → **désactivé** (sinon verrouillage forcé à 30 s) | Paramètres → Batterie → Économie d'énergie → **désactivé** |
| Volume | Monte le son pendant le test d'alarme | Volume « Multimédia », à monter pendant le test d'alarme |

## Déployer / développer

```bash
cd worker
npm install
npx wrangler deploy        # met le site en ligne
npm test                   # tests de la logique d'alerte
npm run dev                # site en local sur http://localhost:8787
```

- `public/index.html` : le site, avec le réveil intégré
- `src/index.js` : endpoint `/api/events` (carte ESPN + heures estimées)
- `src/logic.js` : parsing ESPN, estimations, et logique d'alertes côté serveur. Elle n'est plus utilisée depuis que le cron est coupé, mais elle est gardée pour d'éventuelles notifs (Pushover).

## Script local (`ufc_reveil.py`)

Une version en ligne de commande, sans dépendance, qui fait sonner le PC (et envoie une notif ntfy si tu donnes un topic).

```bash
python3 ufc_reveil.py --combattant gane
```
