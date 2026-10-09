# Livraison intégrée — contrat Council v1

Council 0.7.25 ajoute un résultat **opt-in** `integrated-verified`. Un mandat historique `draft-pr`, `reviewed-pr` ou `accepted-candidate` ne reçoit aucun droit supplémentaire. Preview, QA de release et déploiement gardent leur autorité séparée.

## Autorité et parcours natif

Le mandat projet déclare une hiérarchie `adoptExistingChildren: true`, `maxContributions: 1`, une clôture `integrated-verified` et un contrat PR non draft :

```json
{
  "protocol": "council-pr-contract-v1",
  "draftOnly": false,
  "result": "integrated-verified",
  "feedback": "review-and-correct",
  "requiredChecks": ["candidate-ci"],
  "integration": {
    "protocol": "council-integrated-delivery-v1",
    "mergeMethod": "squash",
    "requiredChecks": ["integrated-ci"],
    "parentObligations": []
  }
}
```

Chaque feuille code native constitue sa propre mission et sa PR. Les tâches techniques Council ne deviennent pas des livraisons produit. Le job existant d'intake ordonne les feuilles d'une même arborescence par dépendances natives, puis date/identité ; les campagnes distinctes peuvent avancer séparément. Les résultats sans code conservent leur contrat sans PR fictive.

Après le candidat et sa revue indépendante, le publisher publie la PR puis un run publisher distinct reçoit une réservation dans la même enveloppe. Il relit le candidat, la base, la PR native, les contrôles et l'approbation sur ce SHA avant de revendiquer une seule fusion. Le helper `integrate_delivery.py` conserve des fichiers 0600 dans le répertoire Git avant l'envoi natif puis GitHub. Seule une réponse `applied` avec `effectPermission: execute` autorise le PUT de fusion, avec `sha` et `merge_method` explicites. L'absence de permission, une réponse perdue ou un journal existant retiennent l'intention ; `observe` relit uniquement cette même PR. Aucune queue, élévation administrateur, suppression de branche ou nouvelle PR n'est autorisée par ce run.

Le rapport lie société, mission, intention, issue, run, dépôt, PR, base et candidat acceptés. La réussite exige l'ascendance attendue, la présence du commit intégré dans la base autorisée et les contrôles **sur le commit intégré**. Un candidat vert ne remplace pas ces contrôles. Les coûts de tous les runs doivent être terminaux et connus. La feuille reste bloquée jusque-là, y compris après son bundle de contribution vérifié. La feuille suivante reçoit le commit intégré comme base, tout en conservant le candidat et les preuves historiques.

Le script borne ses lectures à dix observations, espacées de 30 secondes et limitées par la durée native du run. Une CI toujours en attente exige une observation du même résultat, sans nouvelle fusion ni nouveau budget implicite.

## Échecs et obligations

Un changement de candidat, de révision de preuve, de plan, d'autorité ou de dépendance retient les nouveaux effets. Après un échec intégré, une correction ou un retour arrière passe par une **mission distincte**, avec sa propre PR, revue, fusion et vérification. Le propriétaire peut consommer cette preuve avec `reconcile-integration-recovery`, le même dépôt/base et une base égale au commit intégré défaillant. Le document natif `council-recovery-<missionId>` fixe les deux hashes de rapports et les critères originaux démontrés. Un rollback qui ne satisfait pas les critères originaux ne libère pas la suite. Révision native et preuve indépendante sont relues avant consommation.

Les obligations propres déclarées dans `parentObligations` nécessitent le document natif `council-parent-obligations-<missionId>` puis `record-parent-obligations`, sous l'autorité du propriétaire. Sa révision et son contenu sont fixés puis relus avant clôture. Un parent produit extérieur à cette mission de feuille reste ouvert : la dernière fusion n'autorise pas sa clôture ni celle d'un milestone. La responsabilité technique des campagnes Linear reste une décision TAD ; leur projection externe appartient au plugin Linear.

## Preuves et limites

Les tests déterministes couvrent ordre des feuilles, base intégrée, contrats historiques, changement de candidat, contrôles intégrés, revendication persistée, réponse perdue et absence de répétition GitHub. La qualification native isolée utilise le worker, les API, les tâches, réservations, runs et documents Paperclip réels, avec CLI/usage et transport GitHub simulés ; le commit squash et son ascendance sont produits dans Git. Ce parcours ne prouve ni une fusion GitHub réelle ni une installation/activation en recette.

L'installation en recette est différée jusqu'à la livraison des lots 3 et 4. Les preuves des tentatives natives bloquées restent immuables dans les artefacts locaux ; elles ne valent pas qualification réussie.

Référence API : [fusion GitHub avec SHA attendu](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).
