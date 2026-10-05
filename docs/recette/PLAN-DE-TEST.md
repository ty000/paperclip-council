# Recette Council : plan à challenger avant Content Assistant

5 octobre 2026. Cible : `council-local`, compagnie `e-ty local` (`ETY`), Council
0.6.0 issu de `a66175a` / PR #35. [Installation vérifiée](INSTALLATION-2026-10-05.md).

**Recommandation : cinq à dix minutes de prise en main, puis un premier petit
ticket Content Assistant utile.** Les contrats, compteurs et transitions ne
nécessitent pas une campagne manuelle supplémentaire. Une automatisation de
navigateur sans modèle reste un test synthétique pertinent pour l'interface.

## Ce qui est déjà vérifié

- Sur le candidat livré : 464 tests, typecheck/build, gate statique et CI verts.
  La comparaison de 1 232 arbres d'éléments valide l'équivalence du refactor UI,
  pas son utilisation par une personne.
- Sur cette recette : configuration conservée, worker prêt après rechargement,
  lectures authentifiées des rosters/missions, bundle servi identique au build,
  pages visibles et rechargeables dans Chromium, aucune erreur JavaScript.
- Les états vides sont réels : aucun roster ni mission Council n'est configuré
  dans cette compagnie. Les écrans peuplés Delivery/Coordination n'ont donc pas
  été exercés dans cette instance. Les anciennes campagnes restent des preuves
  historiques distinctes.

## Arbitrage manuel / synthétique

Les références ci-dessous indiquent une couverture existante ou le point à
compléter ; elles ne prétendent pas que tous les scénarios ont été rejoués en
recette aujourd'hui.

| Sujet générique | Résultat attendu | Couverture / méthode adaptée | Manuel recommandé ? |
| --- | --- | --- | --- |
| Installation, authentification, worker, build servi | Bonne version, routes et pages accessibles, configuration conservée après rechargement | Contrôles API + Playwright exécutés sur la recette ; scripts liés au rapport | Non : déjà automatisé |
| Création et activation d'une équipe et d'un conseil | Rôles distincts, composition et révision conservées, activation de roster sans lancement de mission | `tests/rosters.spec.ts` et scénario API/browser de `tests/functional/run.ts` ; données jetables hors recette | Seulement configurer l'équipe réelle, pas refaire les cas négatifs |
| Autorité, candidat exact, avis, correction bornée | Un mauvais acteur/candidat ne peut accepter ; V2 reçoit une nouvelle revue | `n2-ordinary*.spec.ts`, `n3-*.spec.ts`, `ordinary-installed.ts` et `ordinary-delivery-scenario.ts` | Non ; contrats synthétiques |
| Usage et budget | Réservation puis règlement observé ; usage inconnu reste visible et ne devient pas zéro | `g4-native*.spec.ts`, `admission.spec.ts` et scénarios installés | Non pour les calculs ; lire la consommation réelle du premier ticket |
| Dépendance A → B, coordination et reprise | B attend le résultat accepté exact ; PM/facilitateur restent dans leur mandat | `n6-dependencies.spec.ts`, `n6-coordination.spec.ts`, `functional/n6-scenario.ts` | Non avant un ticket qui a réellement une dépendance |
| Lecture Delivery/Coordination | Raison, acteur suivant, attendu/vérifié et publication inconnue compréhensibles | Projections unitaires + `functional/delivery-coordination-browser.ts` : états peuplés held/unknown, released/ready et started, détails et liens | Seulement apprécier la clarté ; valeurs et transitions couvertes en synthétique |
| Lien vers mission source et mission hors des 50 dernières | La mission demandée est sélectionnée après lecture authentifiée | `functional/run.ts` + `functional/delivery-coordination-browser.ts` : clic réel du lien source, présente/absente de la liste, sélection et rechargement | Non : scénario navigateur synthétique |
| Relecture après redémarrage | Identités et états persistés conservés | Rechargement du worker vérifié ici ; scénarios de persistance/restart en sandbox | Non ; redémarrage complet de l'instance non exigé pour cette prise en main |
| Qualité du travail et publication réelles | Ticket utile, contribution intégrée, critique pertinente, PR avec le bon contenu | Le synthétique vérifie le protocole ; un vrai petit ticket vérifie les modèles et accès réels | Oui sur ce résultat utile, avec lancement/budget/publication cadrés séparément |

Les deux compléments navigateur sont intégrés à `pnpm qualification:bounded`.
Ils utilisent le build installé et des lectures authentifiées du sandbox, puis
remplacent uniquement les réponses GET dans leur propre contexte navigateur.
Les missions, identités de candidat et PR affichées sont explicitement
synthétiques ; aucune décision N5/N6 n'est persistée par ces scénarios. Ils ne
modifient pas la recette et ne lancent aucun modèle. Le JSON fonctionnel porte
`syntheticDeliveryCoordinationUi` et deux résultats obligatoires :
`syntheticDeliveryCoordinationBrowserStates` et
`syntheticSourceMissionLinkAndReload`. Trois captures sont conservées sous
`.paperclip/qualification/ui-synthetic/<commit>/`.

## Parcours manuel minimal proposé

1. **Accès et vocabulaire — 2 minutes, sans mutation.** Ouvrir
   [Council rosters](http://127.0.0.1:3210/ETY/council-rosters) puis
   [Council missions](http://127.0.0.1:3210/ETY/council-missions) avec son compte
   local. Vérifier qu'on reconnaît la compagnie, l'équipe d'exécution et le
   conseil de revue, et qu'une liste vide n'est pas prise pour une panne.
   Ces accès directs sont ceux testés ; ne pas supposer une entrée dédiée dans
   la barre latérale. Noter une incompréhension concrète plutôt qu'un audit UX
   général. Le succès technique de ce point est déjà automatisé.
2. **Lisibilité d'un dossier — 3 à 5 minutes, différable au premier ticket.**
   Dans une mission réellement créée, identifier ce qui est produit, son
   candidat exact, qui doit agir, pourquoi le travail attend et si une PR est
   effectivement connue. Ouvrir la mission source seulement si une dépendance
   existe. Réussite : l'opérateur sait la prochaine action sans lire les logs.
   Les comparaisons de valeurs et les états alternatifs vont en synthétique.
   Ce point est actuellement **non exécutable sur les listes vides** ; il ne
   justifie pas de lancer des agents uniquement pour remplir l'écran.
3. **Résultat du premier ticket Content Assistant — au moment utile.** Lire
   le diff, le résumé de tests et les avis ; confirmer que le livrable répond
   au ticket et que le lien PR pointe vers ce résultat. Faire corriger une
   vraie lacune si nécessaire ; ne pas inventer un défaut pour forcer V2.
   La fusion reste une décision distincte. Ce point utilise la première
   livraison du projet, sans campagne Council factice préalable.

Pour challenger chaque ligne : « Quel jugement humain apporte-t-elle ? ».
Si la réponse se limite à comparer des valeurs, vérifier un HTTP, un bouton ou
une transition, la déplacer vers un test API/navigateur synthétique. Les cas
rares et variantes non nécessaires au premier ticket sont différés.

## Passage à Content Assistant

L'installation est terminée ; le projet n'est pas encore préparé. La prochaine
préparation doit fixer **un dépôt/workspace, un petit ticket, les agents et
leurs instructions, l'équipe/conseil, une période de budget et la destination
de PR**. Réutiliser le profil `ordinary-cli-v1`, avec assistance opérateur
explicite là où le parcours actuel la demande ; aucune modification Paperclip,
aucun runner supplémentaire ni synchronisation Linear/Slack requis pour ce
premier ticket.

Les cinq agents présents appartiennent à la démo Council et au suivi de PR :
ne pas leur attribuer implicitement Content Assistant. Le profil d'admission
`n1OperatingProfile` est absent ; le budget M2 expiré n'est pas réutilisable.
La configuration peut être préparée sans modèle, puis le premier lancement
est cadré avec ses effets réels. Les anciennes qualifications partielles ne
nécessitent pas d'être rejouées pour effacer leur historique.

Un défaut bloquant du parcours nominal mérite une correction ciblée et sa
régression. Une formulation peu claire ou une variante rare ne relance pas
une boucle générale de durcissement.
