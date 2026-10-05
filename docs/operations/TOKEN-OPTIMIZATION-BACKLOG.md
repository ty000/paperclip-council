# Réduction des tokens — réalisations et chantiers restants

Mise à jour du 5 octobre 2026 : les cinq lots S de la PR #38 sont fusionnés et installés en recette depuis **18:22:14 Europe/Paris** ; **R1 et R2 sont maintenant implémentés, testés et revus localement**, sur la base `240c08a36bcf16a511bc807b5c2ebd23eab28d15` (PR #39). Ce constat est le checkpoint initial avant publication ; le statut ultérieur de fusion et d'installation locale est établi par la PR et son reçu d'installation, séparément de la recette. La référence de consommation reste l'audit arrêté à **16:16:02** : aucun nouveau relevé de consommation ni campagne modèle n'a été exécuté. Les autres lots R et les périmètres OPT plus larges restent **candidats**.

Source principale : [audit et preuves](/tmp/codex-token-audit-01a0f3fd/REPORT.md). Le document distingue les défauts observés des économies espérées. Aucune estimation de gain par chantier n'est démontrée ; les gains des chantiers qui se recouvrent ne doivent pas être additionnés.

## Constats après livraison

1. **Gain réel encore inconnu.** Les outils sont installés et sélectionnés, mais aucune mission modèle après installation n'a servi à mesurer leur adoption ou une réduction de consommation. Le replay supprimant 100 lectures inchangées mesure des événements et des octets, pas des tokens économisés.
2. **Intégration partielle.** L'observateur et le paquet compact sont disponibles. Ils ne suppriment pas automatiquement les tours du pilote, les transcriptions complètes ni l'historique d'une session déjà longue. Le préflight doit encore être appelé au bon moment par le parcours de préparation.
3. **Une partie des gros chantiers existe déjà.** Council possède un dispatcher séquentiel, la continuation sur événement terminal, des identités de commande stables et des reprises du candidat. Il faut combler les lacunes démontrées, pas reconstruire cette orchestration.
4. **Les profils natifs sont déjà relativement ciblés.** Les snapshots d'installation montrent sept agents `gpt-5.6-sol / medium`, avec deux ou trois skills sélectionnés. Cela ne mesure pas tout le contexte injecté, mais ne justifie pas une baisse générale de modèle ou un grand nettoyage de ces profils en première priorité.

## Réalisé et preuves

Source revue et fusionnée : [PR #38](https://github.com/ty000/paperclip-council/pull/38), commit `ef817493bf99606d324cac6ef572c23de839a9ab`. Cette référence décrit la livraison S historique ; la base de travail R1/R2 inclut ensuite la PR #39 (`240c08a`). Le plugin déjà installé en recette conserve son propre package `0acd530f83dbbcd5f7087036b08c15c7a3313bce` ; les utilitaires sont une livraison séparée.

| Lot livré | Correspondance | Ce qui est acquis | Ce qui reste ouvert |
| --- | --- | --- | --- |
| S1 | OPT-01, début OPT-16 | Audit fini, identités et doublons contrôlés ; baseline de 446 205 730 tokens sur le préfixe gelé | Consolidation complète pilote/enfants/natif ; comparaison après adoption |
| S2 | Périmètre borné OPT-06 | Projection de mission sur champs autorisés, événement compact et références de preuves | Autres retours bavards, notamment lectures de chats, commandes et logs |
| S3 | Début OPT-02 | Observateur déterministe : 101 lectures, 100 inchangées silencieuses, un événement de 2 368 octets sur fixture | Raccord au pilote évitant réellement les inférences sans décision |
| S4 | OPT-04, début OPT-07 | Paquet compact depuis un checkpoint existant ; mandat et inconnus préservés | Production automatique du checkpoint ; transmission et reprise réellement bornées |
| S5 | Début OPT-09 | Contrôle candidat/bundle complet, limite fournie et caches externes | Adoption avant transfert/lancement et raccord aux contrats de commandes |

Validation du code fusionné : **49 tests opérateur, 474 tests applicatifs**, typecheck, build et audit statique réussis, selon le [rapport de livraison](../reviews/token-small-lots/REPORT.md) et son [registre de preuves](../reviews/token-small-lots/proof.json). Ces validations sont celles de la livraison ; elles n'ont pas été relancées pour cette édition documentaire.

Installation locale : quatre wrappers `council-usage-audit`, `council-watch`, `council-context-packet`, `council-transfer-preflight`, depuis une release conservée sous `~/.local/share/paperclip-council/operations/releases/ef817493bf99606d324cac6ef572c23de839a9ab`.

Installation native `council-local`, société `e-ty local` (`587884dc-195c-4555-8db9-9f3d9541b373`) :

- Skill `council-token-operations` importé, ID `849ec34b-266c-435d-b1fe-8405946de284`, clé `local/47824fb670/council-token-operations`.
- Sept affectations et sept ajouts d'instructions relus après écriture ; contenu antérieur, skills, permissions, modèles et paramètres de réveil préservés.
- Montage par l'adaptateur natif vérifié dans sept profils isolés ; hashes des sept fichiers contrôlés et quatre commandes `--help` réussies.
- Au readback de fin d'installation : service actif et activé, santé OK, agents en pause, aucun nouveau run Council. Le chargement dans un run réel et les gains restent non observés.
- L'adaptateur monte les skills au prochain run autorisé. La source locale doit être conservée ; pas de version native attribuée (`currentVersionId=null`), version des fichiers fixée par les hashes du reçu.

Preuve d'installation : [rapport de recette](/home/davy-lp/.local/share/paperclip-council/deployments/2026-10-05-token-operations-ef81749/RECIPE-INSTALLATION.md) et [reçu](/home/davy-lp/.local/share/paperclip-council/deployments/2026-10-05-token-operations-ef81749/installation-receipt.json), SHA-256 du reçu `74bcc5ea179b9657a5bc37bc062bc4b4301b4a2548ecfcb53f7a07d5d2624209`. Il s'agit d'un état daté, pas d'une garantie permanente de santé.

## R1/R2 réalisés localement

Deux workers ont implémenté des fichiers distincts, puis un reviewer indépendant a revu les deux outils. Les défauts de pagination contradictoire et de JSON ambigu sont corrigés. La revue de publication a ensuite relevé une contradiction possible entre statut exact et issues comptables : elle est corrigée avec trois régressions. Le verdict final sur le commit publié est enregistré dans la [PR #40](https://github.com/ty000/paperclip-council/pull/40).

- **R1 — `compact_output.py`** : un helper avec trois modes pour fichiers explicites de chats, inspections et logs. Sortie totale bornée à 16 Kio par défaut, pagination, signaux critiques hors page, statut d'incomplétude, références et hash de source. Le détail reste sur disque. L'outil est à appeler avant d'injecter la sortie dans le contexte ; il n'intercepte pas automatiquement les appels Codex/MCP.
- **R2 — `usage_compare.py`** : comparaison de deux rapports complets existants, avec compteurs séparés et assertions de cohorte/qualité liées aux hashes des rapports. Données partielles, qualité absente ou périmètres incompatibles donnent une comparaison non concluante, sans pourcentage. Le comparateur ne vérifie pas lui-même les preuves de qualité référencées.
- **Validation locale après correction de publication** : 78 tests opérateur, 632 tests applicatifs réussis et un ignoré ; typecheck et build réussis. Parmi les tests opérateur, 29 couvrent les nouveaux outils ; la revue indépendante initiale avait rejoué les 26 tests précédant cette correction.
- **Limite de cette preuve** : implémentation locale et documentation. L'installation locale ultérieure des deux nouvelles commandes exige son propre reçu ; le skill de recette des cinq lots S ne contient pas R1/R2. Adoption réelle et économies de tokens restent à mesurer.

Détail : [rapport R1/R2](../reviews/token-r1-r2/REPORT.md), [registre des fichiers et checks](../reviews/token-r1-r2/evidence.json), [guide opérateur](TOKEN-EFFICIENCY.md#operational-boundary).

## Lots S–M : état et suites candidates

Dimensionnement conservé : **S = un lot ciblé**, **M = deux à trois lots**, **L = quatre à six**, **XL = sept ou plus**. Chaque lot comprend validation et revue ; ce ne sont ni des jours ni un nombre garanti de runs modèle. Les tailles suivantes concernent le reste proposé, pas la totalité historique d'un OPT.

| Priorité / état | Lot | Taille | Gain attendu et confiance | Condition de fin |
| --- | --- | --- | --- | --- |
| Livré localement | **R1 — Borner les sorties restantes** : chats, inspections et logs ; extension OPT-06 | **S** | Potentiel direct élevé sur les lectures volumineuses ; effet sur les tokens suivants à mesurer | Helper local validé : résumé ≤16 Kio par défaut, pagination/omissions et signaux critiques explicites, détail référencé ; raccord automatique aux appels hors périmètre |
| Livré localement | **R2 — Comparateur avant/après** : fin du premier périmètre OPT-16 | **S** | Gain direct nul ; évite d'investir dans une fausse économie | Deux rapports explicites comparés à périmètre compatible ; entrée hors cache/cache/sortie/appels/qualité séparés ; absence ou incompatibilité = comparaison non concluante |
| 2 | **R3 — Client de commandes borné et garde contre les répétitions** : OPT-08 + sous-ensemble OPT-11 | **M, 3 lots** | Potentiel élevé sur rejets de schéma, identités recopiées et reprises administratives ; fréquence future inconnue | Deux flux seulement, `prepare-resubmission` et `recover-candidate` : validation locale, corps/clé durables, readback après réponse perdue, aucun nouvel effet ni nouvelle clé de remplacement |
| 2 | **R4 — Produire le paquet de correction/revue V2** : raccord OPT-04/07/14 | **M, 2–3 lots** | Potentiel élevé sur le contexte si le parcours consomme effectivement le paquet ; confiance moyenne | Générer depuis état/proofs exacts le mandat, le diff V1→V2 et les impacts ; conserver candidat courant, questions des slots et accès au diff complet ; nouvelle revue V2 indépendante et défaut injecté retrouvé |
| 3 | **R5 — Un point d'entrée de préparation du transfert** : adoption OPT-09 | **S** | Gain surtout sur incidents évités ; préflight existant réutilisé | Une commande compose identité Git, bundle, limite autoritative, caches et rapport ; sur fixture bloquée, le parcours composé n'appelle pas son étape suivante ; pas d'upload ni de lancement automatique |
| Conditionnelle | **R6 — Rejouer le réveil prématuré** : audit ciblé OPT-03 | **S pour la preuve** | Prévention utile seulement si le défaut historique est encore reproductible | Ancienne demande du lead + reprise de revue : zéro réveil prématuré, un réveil légitime ; si le natif couvre déjà le cas, clôturer sans correctif ; sinon dimensionner séparément le défaut |

**Périmètres et dépendances :**

- **R1 livré** couvre les trois familles via un helper local à modes, sans modifier le client Codex ni promettre un plafond global. Les tests couvrent gros résultat, omission, erreur hors page, pagination contradictoire et accès au détail. La détection textuelle reste heuristique ; `bounded` ne signifie pas absence de tout blocker. Le raccord aux producteurs réels reste nécessaire pour réduire les entrées modèle.
- **R2 livré** réutilise les rapports complets de `usage_audit.py` explicitement fournis. Aucun scan de sessions, nouveau dashboard, nouveau collecteur multi-runtime ni campagne provider. Les tests couvrent rapports exacts, partiels et incompatibles, régression qualité, hashes obsolètes et JSON ambigu. Pas de pourcentage si la qualité ou la couverture manque. Un verdict concluant reste conditionné aux assertions opérateur.
- **R3** se découpe en inventaire/validation des deux contrats, client et journal de commande, puis scénarios réponse perdue/conflit/refus répété. Les routes et autorités de `prepare-resubmission` (agent admis) et `recover-candidate` (owner) restent distinctes ; aucun credential owner n'est transmis aux agents. Le readback est prioritaire ; un rejeu identique n'est permis que par le contrat natif établi. Le garde arrête les refus identiques sans fait nouveau ; il ne qualifie pas toute attente de boucle. Pas de SDK général, modification des droits ou décision de reviewer par le code.
- **R4** se découpe en construction déterministe du paquet, consommation par un parcours borné, puis preuve de non-régression si elle exige un lot distinct. S4 projette un checkpoint mais ne le construit pas. Un candidat ou une preuve modifiés imposent un sujet et un avis nouveaux ; aucune approbation V1 recyclée. L'absence d'un mécanisme d'injection effectif fait arrêter ce raccord plutôt que revendiquer un contexte réduit. Toute comparaison provider reste un lot d'exécution distinct.
- **R5** vient après clarification des entrées du client R3 si les contrats se chevauchent. Taille S uniquement pour composer les checks locaux existants et fournir un rapport d'admission au parcours choisi. Des changements du host/adaptateur pour imposer ce contrôle partout feraient passer le travail à M ou au programme XL. Ne pas agrandir les limites ni altérer un bundle pour le faire passer.
- **R6** commence par les tests et événements natifs existants ; aucune reprise réelle d'agent pour provoquer l'incident. Gain non chiffrable à partir du seul minimum historique de 170 251 tokens. Un défaut reproduit change sa priorité, pas l'autorisation de lancer une campagne.

**R1 et R2 sont réalisés localement. Suites conseillées : R3 et R4 ; R5 selon fréquence des transferts. R6 seulement si l'inspection montre une lacune.** Ne pas additionner leurs gains, ni ceux du programme XL qui réutilise ces briques.

## Un seul programme XL envisageable : réduire le travail du pilote

**Candidat XL — Pilotage technique déterministe avec contexte borné aux décisions.** Il prolonge OPT-02/04/07/08/11 et les seules lacunes OPT-12 prouvées. L'objectif est de sortir du modèle l'observation inchangée, la préparation administrative et la reprise mécanique, puis de lui transmettre un paquet borné quand une décision ou du travail intellectuel est nécessaire. Les contrôleurs Council existants restent propriétaires des transitions, du verdict et des effets.

**Pourquoi ce candidat :** le pilote représentait 50 132 134 tokens sur les 93 900 306 connus de la séquence PEZ-599. Ce total inclut toutefois 6 585 769 tokens de développement ponctuel de la reprise Council : les compter comme économie récurrente serait trompeur. Après retrait de cette seule phase, il reste **43 546 365 tokens de pilote** sur **87 314 537 connus**. Cela indique où chercher, sans identifier toute cette consommation comme évitable ni produire une facture complète.

Scénario arithmétique, **pas prévision** : enlever 40 % de ce pilotage résiduel représenterait **17 418 546 tokens**, environ **19,95 % du sous-total connu ajusté**. La part encore supprimable après R1–R5 n'est pas connue. Les 58,98 M associés aux attentes sur l'ensemble du chat ne doivent pas être ajoutés à ce scénario, qui couvre une autre période/périmètre.

**Décision actuelle : étude S justifiée, construction XL non justifiée sans preuve supplémentaire.**

Avant de lancer le programme complet, un lot S doit produire une matrice des capacités réellement disponibles : attente durable, notification ciblée, création/reprise de tâche autorisée avec contexte effectivement borné, lecture native des reçus. Utiliser d'abord ces mécanismes ; pas de nouveau chat utilisateur sans demande, ni de daemon de réveil installé par défaut. Une capacité absente ou une autorité indéterminée arrête cette piste ou impose un nouveau cadrage.

Seuils proposés pour décider, à valider sur une référence **après les petits lots**, avec scénario nominal, correction et interruption :

1. Démontrer la suppression des inférences sur état inchangé, puis viser **au moins 40 % de tokens de pilotage en moins**, sans déplacer le coût dans des agents non comptés. Exiger aussi les appels modèle et leur ventilation cache/hors cache/sortie.
2. Conserver les contrôles d'identité, les statuts inconnus, la qualité fonctionnelle, les défauts détectés et l'indépendance du verdict. Une économie obtenue en sautant un contrôle n'est pas admissible.
3. Aucun coût monétaire annoncé sans barème et usages compatibles ; pas de régression inexpliquée d'entrée hors cache, de sortie ou de retries. Une économie surtout en cache ne vaut pas le même montant qu'une économie hors cache.
4. Prévoir un amortissement en **cinq séquences comparables au plus** : `coût complet de construction et qualification / économie nette par séquence`. Le numérateur et le dénominateur doivent partager une unité et une couverture ; si le coût complet est inconnu, le retour sur investissement reste inconnu. Le seuil cinq est un critère proposé, pas un résultat.

Découpage initial **7–10 lots**, à réestimer après les S–M : capacités et mesure (1) ; état/checkpoints durables (1–2) ; raccord observation/notification (1–2) ; consommation des paquets aux décisions (1–2) ; reprises et idempotence autour des effets existants (1) ; qualification comparative et recette (2). Les lots déjà couverts par R1–R5 sont déduits, jamais recomptés. Si le reliquat tient dans 4–6 lots, le reclasser L au lieu de conserver artificiellement XL.

Verdict de découpage : **split required**. Propriétaires à confirmer par surface : outillage du pilote pour attente/paquets ; Council pour contrats et décisions ; Paperclip/adaptateur uniquement pour un raccord natif manquant. Avant toute modification d'un contrat partagé ou de runtimes distribués, produire la classification de migration et les tranches ordonnées ; ce document n'autorise aucune écriture de contrat.

**Non retenus comme XL prioritaire :** plafond strict pendant un appel (OPT-10), faute de capacité de contrôle démontrée ; refonte générale des reprises (OPT-12), déjà partiellement livrées ; optimisation isolée du cache, déjà à 97,3 % sur l'audit. Ces pistes ne disposent pas aujourd'hui d'un gain marginal démontré supérieur au travail sur le pilote.

## Références de la réévaluation

- [Outils livrés](TOKEN-EFFICIENCY.md), [audit fini](../../scripts/operations/usage_audit.py), [observateur](../../scripts/operations/mission_watch.py), [paquet](../../scripts/operations/context_packet.py), [préflight](../../scripts/operations/transfer_preflight.py).
- Contrôleur et événements existants : [n2-ordinary-runtime.ts](../../src/n2-ordinary-runtime.ts), [n2-finished-event.ts](../../src/n2-finished-event.ts). Tests [événements et coûts différés](../../tests/n2-finished-event.spec.ts), [réveil et reprise native](../../tests/n2-native-release.spec.ts).
- Contrats à réutiliser : [instructions ordinaires](../../src/n2-ordinary-instructions.ts), [commandes d'agent](../../src/n2-ordinary-agent.ts), [commandes de mission](../../src/missions.ts), [reprise du candidat](../recette/CANDIDATE-RECOVERY.md), [identité et attribution Git](../../tests/integration.spec.ts).
- Les profils et montages cités proviennent du reçu d'installation daté, pas d'une nouvelle exécution modèle. Le code Council a été relu sur `ef81749` ; les changements futurs de runtime imposent une vérification de contrat avant mise en œuvre.

Les fiches OPT ci-dessous conservent leur périmètre initial ; leur statut précise désormais ce qui reste à livrer.

## Sources et critères communs

- **E1 — Coût du pilote** : audit, constat 1 et ventilation par phase. 50,13 M tokens de pilotage pour la séquence PEZ-599, correctif de reprise Council compris ; 43,77 M natifs connus.
- **E2 — Contexte et surveillance** : constat 2. Entrée moyenne de 135 k ; 423 réponses associées à des appels uniquement d'attente/poll, 58,98 M tokens. Le rattachement des usages est un indicateur, pas une attribution certaine de gaspillage.
- **E3 — Budget et obstacles** : constat 3. 24 M dépassés à 32,53 M ; correction réservée à 3 M terminant à 6,58 M ; taille de pièce jointe et rejets de contrat.
- **E4 — Réveil et usage inconnu** : constat 4. Réveil automatique imprévu, annulation, au moins 170 251 tokens observés sans total final.
- **E5 — Qualité réelle** : constat 5. Défaut du cookie découvert en revue ; harness SSR à rendre représentatif du vrai loader ; correction, bundle et resoumission.
- **E6 — Sémantique et configuration** : constat 6, doublons et limites. Cache inclus dans l'entrée ; compactions incluses dans certains cumuls ; 309 répétitions de token_count ; usages enfants incomplets ; contexte du pilote principalement Astra/xhigh.
- **E7 — Lectures répétées possibles** : optimisation proposée 6. Appels mentionnant skills et mémoire, catégories chevauchantes. La fréquence d'une mention ne prouve pas une relecture complète inutile.

Validation commune : conserver les critères fonctionnels, la revue indépendante requise, l'identité du candidat et des preuves, l'idempotence et les statuts d'effet ou de coût inconnus. Mesurer séparément entrée hors cache, cache, sortie, appels modèle, durée et qualité du résultat. Distinguer simulation, exécution native et coût réellement facturé.

## OPT-01 — Mesure unifiée de la dépense complète

**Statut : partiel.** S1 livré, fusionné et installé ; consolidation complète des sources non livrée. R2 fournit localement la comparaison de rapports déjà disponibles ; il ne consolide pas de nouvelles sources.

Catégorie : observability, reliability. Preuve : supported, confiance élevée. Sources : E1, E6.

**Surface candidate :** collecteur d'audit/outillage Codex, raccord aux métriques Council et Paperclip existantes.

**Travail :** définir un contrat de mesure avec mission/run/session/parent, origine, modèle, base du compteur (delta, cumul ou contexte), cache inclus ou exclus, compaction et état connu/incomplet. Consolider pilote, sous-agents, runs natifs et revues accessibles ; marquer les sources absentes. Dédoublonner par identités stables sans additionner les snapshots cumulés. Séparer consommation et réservations.

**Économie visée :** indirecte ; rendre visibles les dépenses omises et comparer les optimisations.

**Acceptation :** rejouer le préfixe audité et retrouver 446 205 730 tokens pour le pilote ; reproduire les ventilations sans doublon ; ne pas convertir un usage inconnu en zéro. Ne pas construire un nouveau dashboard produit dans ce lot.

**Dépendances :** aucune pour la partie hors ligne ; accès et contrats de chaque source à vérifier avant leur intégration.

## OPT-02 — Observation de l'avancement sans inférence périodique

**Statut : partiel.** S3 livré et installé ; suppression effective des inférences périodiques du pilote non qualifiée. Raccord restant dans le candidat XL, après vérification des capacités natives.

Catégorie : refactor, reliability. Preuve : supported, confiance élevée sur le comportement, moyenne sur l'économie. Sources : E1, E2.

**Surface candidate :** superviseur/outillage Codex et observateur Paperclip.

**Travail :** déplacer les interrogations de statut dans un processus déterministe ; détecter les changements utiles ; regrouper les notifications ; transmettre un delta compact au modèle à la fin, sur blocage, dépassement ou décision requise. Utiliser les événements/attentes natifs disponibles ; prévoir un polling déterministe de secours sans réveiller le modèle à chaque tick.

**Acceptation :** une série de statuts inchangés ne déclenche aucune nouvelle inférence de supervision ; chaque événement utile déclenche une notification dédoublonnée dans une latence définie. L'observation conserve les contrôles d'effets. Ne pas traiter toute attente comme du gaspillage ni confondre baisse des messages visibles et baisse des inférences.

**Dépendances :** OPT-01 pour mesurer ; vérifier la capacité d'attente du client/adaptateur avant de choisir l'intégration.

## OPT-03 — Réveils liés à l'état réel de la mission

**Statut : à requalifier sur l'existant.** Des barrières natives et tests existent ; le défaut historique n'a pas été reproduit sur l'état actuel. R6 borne la preuve avant tout correctif.

Catégorie : reliability, risk-reduction. Preuve : supported, confiance élevée. Sources : E4.

**Surface candidate :** configuration des agents, orchestration Council, réconciliation native Paperclip.

**Travail :** inventorier les causes de réveil et reprises pendantes ; conditionner reprise/déblocage au rôle actuellement attendu ; dédoublonner les déclenchements et vérifier l'état par readback. Examiner d'abord les mécanismes natifs ; modifier le cœur seulement si une lacune est démontrée.

**Acceptation :** reproduire la reprise de revue avec une ancienne demande du lead ; aucun run lead ne part avant la correction effectivement autorisée. Le réveil légitime reste possible une seule fois. Aucun contournement des états inconnus par nouvelle clé.

**Dépendances :** inspection native bornée ; OPT-01 pour rendre le coût d'un éventuel réveil visible.

## OPT-04 — Contexte borné par lot de travail

**Statut : partiel.** Projection S4 livrée et installée ; génération du checkpoint, adoption et réduction du contexte effectif restent ouvertes, notamment via R4.

Catégorie : refactor, maintainability. Preuve : supported pour le volume, inferred pour la solution, confiance moyenne. Sources : E2.

**Surface candidate :** orchestration Codex et contrats de transmission entre étapes.

**Travail :** définir un paquet de contexte limité à l'objectif, base/candidat, périmètre, décisions, risques, preuves et action suivante ; laisser l'historique complet consultable. Décider d'une reprise compacte ou d'une session de travail dédiée selon les capacités disponibles ; ne pas recopier tout N1–N6 dans chaque tâche.

**Acceptation :** une petite correction se traite avec un contexte sensiblement inférieur à la référence de 135 k, sans perte d'identité, d'autorisation ni d'alerte connue. La cible expérimentale 30–50 k doit être mesurée ; elle n'est pas une norme. Ne pas créer de chats utilisateur sans demande correspondante.

**Dépendances :** OPT-01, OPT-16 ; OPT-07 pour la source canonique de reprise.

## OPT-05 — Instructions, skills et outils adaptés au rôle

**Statut : candidat différé.** Les profils Council observés ont déjà deux ou trois skills et un effort medium. Mesurer l'injection effective du pilote avant de choisir une réduction ; ne pas généraliser ce constat à son catalogue Codex.

Catégorie : docs, maintainability. Preuve : inferred, confiance moyenne. Sources : E2, E7.

**Surface candidate :** profils d'agents Paperclip, AGENTS.md, skills/plugins et configurations MCP gérées par l'outillage.

**Travail :** mesurer la part des instructions initiales ; retirer les redondances ; distribuer les seules consignes utiles au rôle ; charger les références à la demande ; limiter les outils/MCP actifs lorsque la configuration le permet. Conserver les règles nécessaires de sécurité, de scope et de preuve.

**Acceptation :** comparer la taille réelle du premier contexte et la réussite de tâches représentatives avant/après ; tester que les règles obligatoires restent appliquées. Une liste plus courte de skills recommandés ne prouve pas que le catalogue injecté a diminué.

**Dépendances :** OPT-01, OPT-16 ; capacités de profil et d'injection à vérifier. Gain non quantifiable avec les seules mentions de chemins dans l'audit.

## OPT-06 — Retours d'outils limités aux données utiles

**Statut : S2 livré sur son périmètre ; extension R1 implémentée et validée localement.** La projection de mission et les trois modes locaux existent, sans interception automatique des lectures de chat, logs et autres outils.

Catégorie : refactor, maintainability. Preuve : supported pour les volumes/troncatures, inferred pour le gain, confiance moyenne. Sources : E2, E6, E7.

**Surface candidate :** helpers shell/API, lectures de chats et outils d'audit.

**Travail :** sélectionner les champs avant retour au modèle ; renvoyer état, delta, erreur et référence de preuve ; paginer/rechercher avant de lire ; garder les sorties complètes sur disque ; éviter les dumps de métadonnées et transcriptions complètes.

**Acceptation :** fixer un budget de sortie par type d'outil, détecter les troncatures, retrouver le détail par référence et vérifier qu'aucun signal de blocage n'est masqué. Mesurer les tokens d'entrée des réponses suivantes, pas seulement les caractères retournés.

**Dépendances :** OPT-01 ; utile avec OPT-02 et OPT-04, gains chevauchants.

## OPT-07 — Mémoire de travail compacte et mise à jour sur transition

**Statut : partiel.** S4 produit le paquet depuis un checkpoint fourni ; il n'écrit pas automatiquement un état canonique sur transition. R4 couvre un parcours, le candidat XL une intégration plus large.

Catégorie : refactor, docs. Preuve : inferred, confiance moyenne. Sources : E7, E2.

**Surface candidate :** livingMemoryLedger, tracker de livraison, helpers de reprise.

**Travail :** séparer état courant compact et historique append-only ; indexer les preuves ; actualiser les checkpoints aux changements utiles ; transmettre seulement les faits pertinents à la reprise ; éviter les relectures intégrales inchangées.

**Acceptation :** reprise après interruption identifiant le bon candidat, mandat, coût inconnu et prochain acteur à partir du checkpoint ; changements d'état non perdus ; diminution mesurée des entrées liées au suivi. Ne pas supprimer les preuves historiques ni prétendre que 358 mentions de mémoire sont 358 relectures inutiles.

**Dépendances :** OPT-01 ; coordonner le format avec OPT-04.

## OPT-08 — Commandes Council construites par un client déterministe

**Statut : candidat prioritaire R3.** Les contrats et reçus existent côté serveur ; le client borné évitant leur reconstruction par le modèle reste à livrer.

Catégorie : refactor, reliability. Preuve : supported, confiance élevée. Sources : E3.

**Surface candidate :** helpers/SDK Council et instructions ordinaires des agents.

**Travail :** construire et valider les payloads depuis le contrat installé ; lire les SHA directement dans Git ; contrôler les chemins ; récupérer la version attendue ; conserver le corps et la clé d'une commande à effet incertain ; afficher une erreur exploitable sans improvisation de schéma.

**Acceptation :** rejouer les rejets de champ API et de déclaration des chemins ; les payloads incorrects sont rejetés localement avant requête ; une réponse perdue rejoue exactement la même commande puis procède au readback. Ne pas déléguer le verdict du reviewer au helper.

**Dépendances :** contrat runtime exact à inventorier ; OPT-01 pour comparer les tentatives.

## OPT-09 — Préflight complet avant consommation des agents

**Statut : partiel.** S5 livré et installé pour bundle/cache/identité ; adoption composée proposée en R5. Aucun contrôle universel avant chaque appel modèle n'est revendiqué.

Catégorie : reliability, tests. Preuve : supported, confiance élevée. Sources : E3.

**Surface candidate :** scripts de campagne/qualification et configuration locale des workspaces.

**Travail :** vérifier taille/complétude/transfert du bundle, permissions et caches temporaires, dépendances nécessaires, identité Git, contrat API et destination de preuve. Faire échouer la préparation avant le premier appel modèle si le transfert prévu est impossible.

**Acceptation :** le cas bundle 21,5 Mo/limite 10 Mo et le cache npm non accessible sont détectés hors provider ; un bundle complet passe les contrôles existants sans réduction invalide. Ne pas modifier automatiquement une configuration sensible ou augmenter une enveloppe.

**Dépendances :** réutiliser les checks existants, puis combler leurs lacunes ; OPT-08 pour les contrats de commande.

## OPT-10 — Budget suivi pendant l'exécution avec arrêt maîtrisé

**Statut : différé pour le contrôle strict.** Réservations et règlement terminal existent ; l'arrêt fiable en cours d'appel n'est pas établi. Ne pas engager ce XL avant une preuve de capacité et de gain.

Catégorie : reliability, risk-reduction. Preuve : supported, confiance élevée sur l'absence de plafond observé, capacité cible à confirmer. Sources : E3, E4, E6.

**Surface candidate :** G4/Council, collecte d'usage et adaptateur d'exécution.

**Travail :** intégrer les deltas disponibles pendant le run ; distinguer réserve, consommation et exposition inconnue ; signaler les seuils ; empêcher le prochain appel quand le contrôle est disponible ; prévoir un arrêt à point sûr et un reçu durable. Inclure le budget du pilote quand il est observable.

**Acceptation :** un dépassement simulé interrompt l'admission suivante et conserve les usages et effets ; documenter le dépassement résiduel possible d'un appel déjà en vol. Ne pas promettre un plafond strict si l'adaptateur ne permet qu'une observation après coup ; garder ce sous-lot différé si nécessaire.

**Dépendances :** OPT-01, capacités de l'adaptateur, coordination avec OPT-12. Les API nécessaires ne sont pas établies par cet audit.

## OPT-11 — Détection des boucles sans progrès

**Statut : candidat borné R3 pour les refus de commande.** Détection générale du progrès hors de ce M ; à considérer seulement si les métriques la justifient.

Catégorie : reliability, risk-reduction. Preuve : inferred, confiance moyenne. Sources : E2, E3.

**Surface candidate :** superviseur, politique d'exécution et helpers d'erreur.

**Travail :** définir ce qui constitue un progrès (preuve, diff, état de tâche, diagnostic nouveau) ; reconnaître le même refus/action répété sans nouvelle donnée ; borner les tentatives identiques ; rendre le blocage et les preuves exploitables. Distinguer attente normale, test long et boucle active.

**Acceptation :** scénario de refus répété arrêté au seuil configuré ; scénario de travail lent mais progressif non interrompu ; aucune relance automatique avec une nouvelle clé après effet incertain. La détection doit être déterministe autant que possible.

**Dépendances :** OPT-01, OPT-02, OPT-08 ; seuils à calibrer via OPT-16.

## OPT-12 — Reprise durable sans refaire les contributions

**Statut : partiellement existant avant les cinq lots S.** Reprise du candidat et protections natives à réutiliser ; aucune refonte générale justifiée. Cartographier uniquement les frontières encore manquantes.

Catégorie : reliability, tests. Preuve : supported, confiance élevée. Sources : E3, E4.

**Surface candidate :** checkpoints et commandes de reprise Council, reçus de run et artefacts.

**Travail :** couvrir les frontières critiques : contribution terminée, intégration prête, bundle uploadé, candidat non encore enregistré, run arrêté avant règlement. Réutiliser les corrections de reprise déjà livrées ; ajouter seulement les cas manquants après audit ciblé. Conserver identités et historique des effets.

**Acceptation :** injection d'interruption à chaque frontière, reprise du même candidat/contributions sans nouvelle implémentation ni double règlement ; coût inconnu conservé s'il reste impossible à établir. Ne pas reconstruire des reçus fictifs ni repartir sous une nouvelle identité pour contourner un blocage.

**Dépendances :** OPT-08, OPT-09 ; coordonner l'arrêt avec OPT-10.

## OPT-13 — Vérifications représentatives avant la revue coûteuse

**Statut : candidat dépendant du projet.** Le défaut cookie/harness vient de Content Assistant ; son état courant n'a pas été réaudité ici. L'identité du candidat et des bundles est déjà contrôlée côté Council. Ne pas promettre un nouveau gain sur un test déjà corrigé.

Catégorie : tests, build/CI repair. Preuve : supported, confiance élevée. Sources : E5, E3.

**Surface candidate :** harness Content Assistant, préflight de soumission Council et sélection des contrôles.

**Travail :** placer le vrai parcours GET → cookie → POST et les contrôles bloquants avant la soumission ; sélectionner les vérifications selon les fichiers et dépendances touchés ; réutiliser un résultat uniquement si candidat, configuration, environnement et entrées pertinentes restent identiques.

**Acceptation :** le défaut du cookie et les blocages CI connus sont détectés avant le réveil des reviewers ; une modification pertinente invalide automatiquement la preuve réutilisée. Garder les vérifications complètes exigées ; ne pas confondre test synthétique et preuve native.

**Dépendances :** OPT-09 et identités de preuve ; OPT-16 pour vérifier la non-régression de qualité.

## OPT-14 — Revue indépendante avec mandat ciblé et contexte limité

**Statut : partiel dans les contrats existants, extension R4.** Slots, questions et sujet exact existent déjà ; la nouveauté proposée est la préparation et la consommation du paquet V2, sans réduire les obligations de revue.

Catégorie : refactor, docs. Preuve : supported pour l'utilité des revues, inferred pour leur réduction, confiance moyenne. Sources : E5, E1.

**Surface candidate :** missions N2/N3, instructions du reviewer et des spécialistes, outillage de revue Codex.

**Travail :** fournir diff et preuves exactes ; attribuer des questions distinctes aux spécialistes requis ; borner les findings au périmètre ; en V2, examiner le correctif et ses impacts avec une nouvelle revue liée au candidat. Éviter les requalifications identiques sans nouveau motif, conserver le reviewer final désigné.

**Acceptation :** défaut injecté retrouvé, dépendance touchée examinée, amélioration périphérique différée et verdict indépendant sur le candidat courant. Ne pas reporter un avis V1 comme approbation V2 ni supprimer des spécialités obligatoires pour baisser le compteur.

**Dépendances :** OPT-04, OPT-06, OPT-13, OPT-16.

## OPT-15 — Modèle et effort proportionnés à l'activité

**Statut : candidat différé après mesure.** Aucun réglage changé ; les agents de recette sont déjà en medium. Une qualification de modèle concerne surtout les tâches coûteuses identifiées du pilote, pas une baisse générale automatique.

Catégorie : maintainability, risk-reduction. Preuve : inferred, confiance moyenne. Sources : E6.

**Surface candidate :** profils Codex et agents Paperclip, mapping de sélection existant.

**Travail :** comparer des réglages disponibles sur des tâches identiques ; réserver l'effort élevé aux décisions difficiles ; éviter une inférence pour les opérations déterministes ; prévoir l'escalade sur preuve d'échec. Respecter les choix explicites et vérifier la configuration effective.

**Acceptation :** qualité égale sur le jeu représentatif, avec coût total mesuré incluant retries et escalades. Rapporter séparément réduction des tokens, durée et coût : un modèle moins cher peut consommer davantage de tokens. Aucun modèle précis n'est sélectionné par cette liste.

**Dépendances :** OPT-01 et OPT-16 ; vérifier disponibilité, mapping et tarifs au moment du choix.

## OPT-16 — Comparaison avant/après et garde contre les régressions

**Statut : baseline S1 livrée ; comparateur R2 implémenté et validé localement.** Aucun résultat après adoption ni économie réelle qualifiée à ce stade. Les assertions de cohorte/qualité doivent être établies séparément.

Catégorie : tests, observability. Preuve : supported pour la nécessité de mesurer, confiance élevée. Sources : E1–E7.

**Surface candidate :** outillage d'audit et qualification Council.

**Travail :** fixer des cas comparables : attente inchangée, petite correction, transfert bloqué, reprise et revue ; enregistrer résultat fonctionnel, appels modèle, distribution de taille du contexte, tokens par catégorie, coût connu, durée et interventions. Définir une baseline avant de cumuler plusieurs changements ; signaler variance et inconnus.

**Acceptation :** mesure avant/après reproductible, sans double comptage ; économie accompagnée d'un niveau de qualité inchangé ; pas de pourcentage attribué arbitrairement à un seul changement quand plusieurs changent ensemble. Démarrer par les traces et fixtures existantes ; toute nouvelle campagne provider relève d'un lot d'exécution distinct.

**Dépendances :** OPT-01. Gain direct nul attendu ; chantier de preuve indispensable à la sélection des autres.

## Ordre initial conservé pour traçabilité

R1/R2 sont réalisés localement ; les prochains candidats sont R3/R4/R5, avec R6 conditionnel et XL soumis aux seuils précédents. La liste initiale suivante explique le choix des cinq lots S déjà réalisés ; elle ne les remet pas à faire.

1. **Mesure de référence : OPT-01 et préparation OPT-16.** Réutiliser les traces, sans nouvelle campagne.
2. **Plus gros leviers directs : OPT-02, OPT-04, OPT-06**, accompagnés de OPT-07 ; étudier OPT-05 après mesure de la part des instructions.
3. **Dépenses accidentelles et reprises : OPT-03, OPT-08, OPT-09, OPT-12**, puis OPT-10/11 selon les contrôles accessibles. Une lacune provoquant des runs intempestifs peut justifier d'avancer OPT-03.
4. **Réduire le travail répété à qualité égale : OPT-13 et OPT-14.**
5. **Ajuster les réglages : OPT-15**, puis conclure la comparaison OPT-16.

## Parties différées et limites

- Le plafond strict en cours d'appel (OPT-10) dépend de contrôles non vérifiés ; la mesure et l'arrêt avant l'appel suivant restent des sous-lots distincts.
- La réduction réelle du catalogue d'outils/instructions (OPT-05) dépend des capacités de configuration du client, pas seulement des prompts du dépôt.
- Le cache est déjà très utilisé (97,3 % des entrées du pilote). Aucun chantier autonome d'amélioration du taux de cache n'est priorisé sans mesure montrant un problème résiduel.
- Les gains des contextes compacts, sorties limitées et checkpoints se recouvrent. Une baisse de tokens bruts n'est pas automatiquement une baisse proportionnelle de prix.
- Aucun nouveau produit, dashboard ou framework multi-agent n'est proposé. Les mécanismes natifs et helpers existants sont à réutiliser avant de créer un plugin ou modifier Paperclip.
