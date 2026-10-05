# Reprendre un candidat construit après la fin du lead

La commande propriétaire `recover-candidate` enregistre le premier candidat
après un échec de transfert ou de publication du lead. Elle conserve les deux
commits de contribution, leurs auteurs, les trois runs et leurs règlements.
Elle ne lance aucun agent et n'accepte pas la livraison.

Préconditions : mission native en `executing` ou `integrating`, aucun candidat
ou N2/N5 existant, deux enfants terminés, exactement les trois runs originaux
réussis et soldés avec consommation connue et exposition nulle. Une enveloppe
épuisée n'empêche pas de conserver le travail déjà réalisé ; elle continue
d'interdire une nouvelle exécution.

Déposer le bundle complet sur la racine native et contrôler son hash, sa taille
et ses références `base`/`candidate`. La limite d'upload Paperclip doit couvrir
le bundle, dans la limite Council de 32 MiB. Cette recette utilise le réglage
natif `PAPERCLIP_ATTACHMENT_MAX_BYTES=33554432`, sans modification du core.

Puis envoyer une seule fois, avec la version actuellement relue :

```json
{
  "companyId": "<company UUID>",
  "command": "recover-candidate",
  "commandId": "<UUID généré une fois>",
  "expectedVersion": 15,
  "attachmentId": "<attachment UUID>",
  "baseCommit": "<SHA complet>",
  "candidateCommit": "<SHA complet>",
  "expectedSha256": "<SHA-256 du bundle>",
  "reason": "Transfert terminé par le propriétaire après la fin du lead"
}
```

Route : `POST /api/plugins/<pluginId>/api/companies/<companyId>/missions/<missionId>/commands`.
L'authentification est celle du propriétaire ; aucune identité d'ancien run
n'est réutilisée. Un replay exact relit le reçu, un payload différent avec le
même `commandId` est refusé.

Si le commit d'intégration ajuste des fichiers des contributeurs ou ajoute
une preuve d'assemblage, ajouter `integrationAdjustedPaths`, liste explicite
des fichiers réellement modifiés, après lecture du diff. Le vérificateur
contrôle chaque chemin exact, l'ascendance des contributions, leurs périmètres
et l'unique commit d'intégration. Il conserve les fichiers non déclarés à
l'identique ; les ajustements, y compris suppressions, restent dans le reçu,
le journal et la preuve du candidat. Cette déclaration propriétaire n'est pas
un verdict fonctionnel. Elle est conservée lors de la vérification N2.

Un périmètre de contribution désigne un fichier ou un dossier. `app` et `app/`
désignent le même sous-arbre ; `app-other` reste extérieur. Le plan et le
vérificateur Git appliquent la même détection des chevauchements.

Après succès, relire `ready_for_review`, le candidat exact, les contributions
et les règlements inchangés. La racine native peut rester `blocked` jusqu'au
démarrage explicite de la review. Aucun wakeup ni acceptation N2 n'est implicite.
Une nouvelle période d'admission pour les étapes restantes doit conserver
l'ancienne consommation consultable et ne pas réutiliser son budget dépensé.

## Vérification du correctif du 5 octobre 2026

Les tests couvrent la route propriétaire, le replay, l'identité, les versions,
les runs/consommations non terminaux, les références et la preuve Git refusée.
Un vrai bundle de test couvre aussi les dossiers avec/sans slash, un préfixe
voisin refusé et les ajustements d'assemblage déclarés ou manquants.

Le bundle Content Assistant `ebef69793395fec77ce03f77c69fb81a31132cf1` a été
rejoué hors ligne avec les deux contributions originales et 14 fichiers
d'assemblage déclarés : 15 contrôles Git réussis. Ce constat ne remplace pas
les avis Development/Quality, le verdict Council ou la publication de la PR.
