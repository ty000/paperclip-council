# Contrat continu Council / Linear — v1

Côté Council : 0.7.26, protocole **`council-linear-continuity-v1`**, activation explicite avant admission. Le contrat initial `linear-intake-revalidation-*.v1` reste inchangé. Un mandat historique ne reçoit pas automatiquement ce protocole ni de droits de contrôle supplémentaires.

**Compatibilité du peer : non acquise.** Le plugin `ty000.linear-intake` 0.4.0 possède le handoff initial, pas les échanges décrits ici. Council attend une réponse authentifiée avec les trois capacités `continuous-context`, `cooperative-control`, `publication-readback`. L'adoption et la qualification du côté Linear restent à réaliser dans son dépôt. Les tests Council avec une contrepartie de conformité déterministe ne prouvent pas le parcours des deux plugins installés ni des écritures Linear réelles.

## Responsabilités et permissions

| Transition | Autorité / réalisation | Primitive disponible | Preuve consommée |
| --- | --- | --- | --- |
| Lecture, version source, mapping des tickets | Plugin Linear | Son accès natif à Linear ; documents Paperclip | Révision source et correspondance initiale |
| Configuration et limites | Propriétaire Paperclip | Commande board Council / mandat projet | Société, projet, sujet importé et hash d'autorité |
| Admission, ordre, runs, revue, PR et fusion | Council / acteurs Paperclip admis | Job existant, tâches, wake, réservations G4, décisions | Candidat et résultat exacts ; coûts connus |
| Notifications inter-plugins | Host Paperclip | `events.emit` / `events.subscribe` | Identité plugin attestée par le host + document relu |
| Contexte ciblé, pause, reprise, annulation | Commande source déléguée par l'opt-in du propriétaire, consommée par Council | Journal Council + tâches/runs natifs | Commande ordonnée, révision précédente, périmètre et document |
| Question et décision | Propriétaire/Council côté Paperclip | Outbox documentaire durable | Intention originale et confirmation de publication |
| Publication et réconciliation externe | Plugin Linear exclusivement | Accès Linear détenu par ce plugin | Relecture de chaque effet dans un reçu natif |
| Clôture de travail et clôture externe | Council puis plugin Linear | Preuve native de clôture puis reçu distinct | `workResultAcquired` et `acknowledgement` séparés |

Aucun accès aux tables du peer, secret inter-plugin, jeton opérateur ni impersonation. Les routes opérateur d'arrêt de sous-arbre ne sont pas utilisées. Les capacités documents/événements/jobs/runs déjà déclarées suffisent ; aucun changement Paperclip ou SDK. `campaignId` est ici un identifiant de corrélation, fixé à l'activation initiale de l'intake dans la configuration projet. Il ne crée pas une campagne, un parent artificiel ou un second ordonnanceur. L'attribution technique des campagnes et milestones reste une décision TAD à prendre séparément.

## Configuration

Un mandat projet qui possède `linearIntake` peut déclarer :

```json
{ "linearContinuity": { "protocol": "council-linear-continuity-v1" } }
```

Le raccord est alors fixé après la préparation importée et **avant toute admission**. L'ancien job `mission-continuity` réconcilie également ces missions préparées ; il répète les demandes documentaires en conservant leurs identités. Sans compatibilité ou publication confirmée, la mission reste préparée, avec son identité et sans allocation/wake supplémentaires.

Pour une mission importée préparée manuellement, `configure-linear-continuity` utilise `missionId`, `commandId`, `expectedVersion`, `binding`. Seul le propriétaire actuel de société/mission peut le faire ; la mission doit encore être `draft`, sans N1. Le binding fixe `companyId`, `projectId`, `missionId`, `nativeRootId`, `campaignId`, `sourceRootId`, `authoritySha256` et le `subject` initial complet. `authoritySha256` est le hash canonique de `{mandate, projectMandate, responsibilities, compositions}`. Aucun contrat déjà exécuté n'est rétroactivement élargi.

`reconcile-linear-continuity` relit les intentions et contrôles. `publish-linear-arbitration` publie une question ou décision bornée (`kind`, `text`) sous le propriétaire actuel ; `resolvesCommandId` relie une décision à la commande retenue. Une poursuite dépendante exige cette décision liée et sa publication confirmée. Son reçu de commande et son intention d'outbox sont persistés dans la même transition CAS. La consommation des commandes et leurs publications de décision sont également atomiques. La configuration seule ne vaut pas activation en recette.

## Demande et réponse durables

Le code canonique des structures strictes est `src/linear-continuity-contract.ts`. Les hashes utilisent la même fonction canonique Council que le handoff initial : clés triées, JSON UTF-8, SHA-256. Pour les références documentaires, `bodySha256` désigne le hash canonique de la **chaîne** du corps ; pour `payloadSha256`, celui de l'objet métier. Ces deux valeurs ne sont pas interchangeables.

1. Council conserve une outbox bornée (64 intentions maximum) et un challenge dans sa mission persistante. L'identifiant UUID d'intention ne change pas en cas de reprise, notification perdue ou réponse incertaine. Le sujet, les preuves, les budgets et les réservations ne sont jamais réinitialisés.
2. Le document `council-linear-publication-<intentId>` contient `{intentId,payloadSha256,payload}`. Son contenu est immuable et sa révision est relue. Le document `council-linear-request-<challengeId>` contient protocole, binding, nonce, horodatages, source, séquence consommée, contrôle et références des publications en attente.
3. Après persistance et readback, Council émet `plugin.private.paperclip-council.linear-continuity-request` avec les références. Une perte du hint entraîne sa réémission, avec le même challenge tant qu'il reste valide. Une nouvelle observation après expiration change le nonce, jamais les intentions métier.
4. Le peer relit la demande, puis écrit un document de réponse sur la racine native et émet **sous son identité host** `plugin.ty000.linear-intake.council-continuity-result`. Le payload du hint contient protocole, société, mission, challenge et référence exacte du document de réponse. Aucun document seul, auteur agent ou événement d'un autre plugin ne constitue une réponse authentifiée.
5. Council lit ce document, vérifie nonce/challenge/hash de demande, binding complet, délai, capacités et révision, puis conserve la réponse dans sa propre mission. Un doublon identique n'applique pas une deuxième transition. Une notification de réponse perdue est récupérée par réémission de la demande originale et relecture/réémission côté peer ; elle n'autorise pas une nouvelle campagne ou publication.

Un challenge vit au plus cinq minutes ; une observation source disponible vit au plus deux minutes. La réémission est bornée à une toutes les 30 secondes. Le peer doit répondre idempotemment et intégrer les demandes non notifiées à sa réconciliation propre. Ses réponses contiennent `availability`, `sourceSha256`, `changes`, `acknowledgements`, `observedAt`, `validUntil` et l'écho exact de la demande.

Une confirmation d'outbox fixe `intentId`, `payloadSha256`, `status: confirmed`, `publicationReceipt`. Le reçu relu contient :

```json
{
  "protocol": "linear-publication-readback-v1",
  "bindingSha256": "<hash du binding>",
  "sourceSha256": "<révision portée par cette intention>",
  "intentId": "<UUID original>",
  "payloadSha256": "<hash original>",
  "status": "confirmed",
  "effects": [{ "sourceId": "<ticket Linear>", "readbackSha256": "<hash de sa relecture>" }]
}
```

Council vérifie l'identité, la révision et le reçu borné ; le plugin Linear possède la vérification des champs externes et du périmètre Linear. Une affirmation Council ou un transport HTTP réussi ne remplace pas cette relecture. Une preuve de clôture Council peut donc rester acquise avec une publication externe en attente. Le reçu confirmé n'est jamais remplacé par une autre révision.

Les observations natives de progression et de blocage sont également reprises dans l'outbox avec leur séquence et la référence exacte de leur document. La publication précédente est retenue avant que l'observation native suivante ne la remplace. Une relecture après redémarrage conserve l'intention originale ; une erreur de transport n'autorise aucun nouveau départ.

## Changements et contrôle coopératif

Chaque changement fixe `commandId`, `sequence`, `kind` (`context`, `pause`, `resume`, `cancel`), `affectedNativeIds`, `previousSourceSha256`, `sourceSha256`, `authoritySha256`, `impact`, `evidence`. Le document d'evidence contient `command` avec tous ces champs **sauf la référence evidence elle-même**, pour éviter un hash circulaire. L'identité UUID, son hash complet et la séquence restent conservés. Une lacune ou un changement de payload sous la même identité bloque la consommation.

Une commande `context` contient aussi une annotation explicite `context` (1–4 000 caractères), fixée dans sa preuve. Council conserve ses cibles et la transmet dans l'assignation native au prochain départ de travail concerné, avec le document/révision d'origine. Les contributions produit reçoivent uniquement leurs annotations ; les acteurs techniques de revue/intégration disposent du contexte consolidé, étiqueté par cible. Un run actif conserve son contexte initial jusqu'au prochain départ sûr. Seuls les suffixes exacts issus des commandes consommées sont reconnus comme contexte Council ; les modifications du texte produit original restent bloquantes.

La v1 adapte les annotations **`context-only`** des seuls nœuds explicitement concernés dans la mission. Les critères, le mandat et les preuves existantes restent fixés. Changement de critère, périmètre, autorité inconnue ou nœud extérieur : question native / publication d'arbitrage, poursuite dépendante retenue. Les travaux indépendants n'ont pas ce contrôle et conservent leur mandat. La révision source externe seule n'autorise jamais à remplacer une preuve du candidat. Une adaptation substantielle attend une décision et un mandat approprié, sans reset silencieux de l'ancien.

- **Panne / expiration / publication incertaine** : les opérations admises peuvent finir ; leurs runs et coûts sont relus/réglés. Les nouvelles admissions, wakes, fusions et clôtures passent par le contrôle commun et restent retenus. Aucun retry de fusion ou publication incertaine.
- **Pause** : `pause_requested` bloque immédiatement ces départs. Le job attend les runs admis terminaux et tous les coûts connus, sans interruption native, puis fixe `paused`.
- **Reprise** : commande explicite et ordonnée, source disponible fraîche, autorité exacte, point sûr, effets connus et arbitrages publiés/confirmés. Les réservations, candidats, preuves et identités restent les mêmes. La décision de reprise doit à son tour être publiée avant un nouveau départ.
- **Annulation** : point sûr, puis au besoin un publisher `cancel-pr` distinct, admis dans l'enveloppe existante, qui revendique une seule fermeture de la PR exacte encore ouverte. Le helper `cancel_delivery.py` journalise avant l'effet, relit le head, ne supprime ni branche ni commits ; une réponse perdue permet seulement l'observation. Une fusion inconnue retient l'annulation. Les commits intégrés restent conservés. Seuls les nœuds produit originaux devenus inactifs passent à `cancelled`, jamais à `done`. L'outbox d'annulation indique `campaignSuccess: false`.

## Qualification et passage au peer

Les tests Council couvrent authenticité host, nonce/société/protocole/lease, doublons/perte de hint/redémarrage, révisions documentaires, séparation résultat/publication, commande atomique, ciblage, dépassement/ordre, panne, règlement terminal, pause/reprise et fermeture PR à effet unique. Les helpers GitHub sont testés avec un transport simulé. Cela reste une qualification Council avec contrepartie déterministe.

Le lot peer devra adopter les schemas et hashes exacts, produire les observations/commandes/reçus, maintenir son propre outbox d'effets Linear et réémettre ses notifications perdues. Avant toute activation : tester les deux plugins compatibles sur un intake borné, deux feuilles code successives, panne/pause/reprise/annulation et readback externe de la clôture. Le handoff initial 0.4.0 est conservé ; il ne suffit pas à cette qualification. Les choix TAD sur campagnes/milestones et l'adaptation substantielle restent visibles dans #73. Installation et activation en recette sont différées à la fin des lots.
