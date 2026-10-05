# Installation Council en recette locale

5 octobre 2026, Europe/Paris. **Installation et contrôle d'accès/UI réussis**
sur `council-local`. Le propriétaire a autorisé cette installation et demandé
un [plan de test manuel à challenger](PLAN-DE-TEST.md). Aucun nouveau run
agent, lancement de mission ou projet Content Assistant n'a été effectué.

## Cible et build

| Élément | Observation |
| --- | --- |
| Origine | `http://127.0.0.1:3210` |
| Compagnie | `e-ty local`, préfixe `ETY`, `587884dc-195c-4555-8db9-9f3d9541b373` |
| Service | `paperclipai-council-local.service`, actif et enabled, PID 494 inchangé |
| Paperclip | Source `61b3fd57a695614dc4a37e2303f426a34a9795cf`, version health `2026.916.0+197.git.61b3fd57a.dirty` ; modifications préexistantes préservées |
| Council | 0.1.0 → **0.6.0**, PR #35 fusionnée, source `a66175afe49c2b044ac5d5b7afe6b687c3861d9a` |
| Identité plugin | `f9c44b78-fddf-4d66-9e1d-c7f0a7957b82`, clé `private.paperclip-council`, conservées |
| Package installé | `/home/davy-lp/.local/share/paperclip-council/releases/a66175afe49c2b044ac5d5b7afe6b687c3861d9a` |
| Profil N2 | `ordinary-cli-v1` |
| Données Council sur cette cible | 0 roster, 0 mission ; pas de profil d'admission N1 configuré |

Le package est extrait du commit fusionné, installé avec le lockfile figé et
construit hors des worktrees temporaires. Le manifeste local recense 213 fichiers
de distribution/migration. Le bundle UI servi fait 74 101 octets et son SHA-256
est `ff940df84495c075bde61385c744e927eb7342a778b9e11c443191b7d9d623e0`, identique
à celui du build installé.

## Opérations et préservation

Une sauvegarde DB native, l'ancien package et la configuration ont été
conservés avant mutation. Les archives passent `gzip -t` ; une restauration DB
n'a pas été exécutée. Les sauvegardes privées restent hors Git.

Le chemin d'upgrade de ce host refuse une évolution ajoutant des capacités.
Après lecture de son contrat, l'installation a utilisé les routes natives de
désinstallation **sans purge**, puis réinstallation de la même clé depuis le
nouveau chemin. L'identifiant, la configuration et sa référence de secret ont
été relus inchangés ; seul `n2RuntimeProfile: ordinary-cli-v1` a été ajouté à
la configuration. Aucun SQL manuel, patch Paperclip ou remplacement de l'ancien
répertoire installé n'a été utilisé.

Le worker a ensuite été désactivé/réactivé par les routes natives ; sa
configuration et les lectures authentifiées survivent à ce rechargement.
Paperclip entier n'a pas été redémarré. Le run préexistant de surveillance des
PR `becea0bc-e123-469f-ac59-72227eb90c21` a été laissé intact ; au contrôle
final aucun run supplémentaire ni run non terminal n'était observé. Les
configurations runtime des cinq agents sont inchangées. Les deux autres
plugins sont toujours `ready` et n'ont pas été modifiés.

## Vérifications observées et limites

- API health OK, plugin 0.6.0 `ready`, rosters et missions accessibles par le
  compte owner après rechargement du worker.
- Playwright/Chromium sur les deux pages réelles : titre et état vide visibles,
  rechargement réussi, aucune erreur JavaScript, deux captures PNG non vides.
- Bundle servi identique au build, configuration relue, service toujours actif
  et enabled ; archive de l'ancien package et dump DB identifiés par hash.
- Aucun appel modèle, démarrage d'agent, création de mission, import de M2 ou
  activation Content Assistant. Le statut natif historique M2 est inchangé.
- Les écrans peuplés Delivery/Coordination, la publication réelle et le
  redémarrage complet de l'hôte ne sont pas qualifiés par cette installation.
  Les tests de source/campagnes antérieurs restent attribués à leurs cibles.

Frontend QA verdict: **pass pour l'accès authentifié et les deux états vides**.
Outil détecté : Playwright 1.62.1 + Chromium local. Aucun défaut bloquant observé
dans ce périmètre. L'appréciation UX des dossiers peuplés reste à faire sur
fixture ou premier ticket ; aucun nouvel audit esthétique n'est imposé.

## Preuves et relecture sans modèle

Répertoire local, privé, hors Git :
`/home/davy-lp/.local/share/paperclip-council/deployments/2026-10-05-a66175a/`.

| Fichier | Rôle |
| --- | --- |
| `authorization.json`, `install-plan.json`, `operations.jsonl` | Mandat, cible et opérations attribuées |
| `release-manifest.json`, `build.log` | Build issu du commit fusionné |
| `installation-check.json`, `worker-reload.json` | État installé, préservation et rechargement |
| `browser-check.json`, `council-rosters.png`, `council-missions.png` | Bundle et UI réellement servis |
| `proof-manifest.json`, `PROOF.md` | Périmètre du verdict et procédure de relecture |
| `private/` | Dump DB, ancien package et snapshots de configuration ; ne pas publier |

Relecture tant que l'instance et la session owner locale sont valides :

```sh
cd /home/davy-lp/.local/share/paperclip-council/deployments/2026-10-05-a66175a
python3 check-installation.py
node browser-check.mjs
```

Ces commandes lisent l'instance et actualisent les observations locales, sans
run agent. Elles ne réinstallent pas le plugin. L'état vide est celui de cette
installation : après configuration réelle, adapter l'attente du test navigateur
à cette évolution plutôt que supprimer des données pour le refaire passer.
Ne pas réexécuter `install_actions.py`, qui est la trace de l'installation
déjà consommée. Le dump précédent ne doit pas écraser des écritures ultérieures
pour un simple retour de version ; une restauration DB exige de cadrer la cible
et les données à conserver.

**Suite :** challenger le plan, puis préparer un premier petit ticket Content
Assistant avec son dépôt, ses acteurs, son budget et sa destination de PR.
L'installation est prête pour cette préparation ; l'équipe projet n'est pas
encore configurée.
