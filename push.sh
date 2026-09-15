#!/bin/bash

set -e

echo "=================================================="
echo "        🚀 PUBLICATION DU PROJET"
echo "=================================================="

# --------------------------------------------------
# 1. Vérifier qu'on est bien dans un dépôt Git
# --------------------------------------------------

if [ ! -d ".git" ]; then
    echo "❌ Ce dossier n'est pas un dépôt Git."
    exit 1
fi

# --------------------------------------------------
# 2. Vérifier la branche
# --------------------------------------------------

BRANCH=$(git branch --show-current)

if [ "$BRANCH" != "main" ]; then
    echo "❌ Le dépôt n'est pas sur la branche main."
    echo "Branche actuelle : ${BRANCH:-DETACHED HEAD}"
    echo ""
    echo "Aucun commit n'a été créé."
    exit 1
fi

echo "🌿 Branche : main"

# --------------------------------------------------
# 3. Vérifier les marqueurs de conflit
# --------------------------------------------------

echo ""
echo "🔎 Vérification des conflits Git..."

if grep -R -n -E '^(<<<<<<<|=======|>>>>>>>)' . \
    --exclude-dir=.git \
    --exclude=push.sh
then
    echo ""
    echo "❌ Des marqueurs de conflit ont été trouvés."
    echo "Corrige-les avant de publier."
    exit 1
fi

echo "✅ Aucun conflit détecté."

# --------------------------------------------------
# 4. Rattraper GitHub sans perdre les fichiers locaux modifiés
# --------------------------------------------------

echo ""
echo "☁️ Vérification de GitHub..."

if [ -n "$(git ls-files -u)" ]; then
    echo "❌ Un conflit Git est déjà en cours ; résous-le avant de publier."
    exit 1
fi

git fetch origin

# Vérifier si GitHub a avancé depuis notre dernière synchronisation
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then

    AHEAD=$(git rev-list --count origin/main..main)
    BEHIND=$(git rev-list --count main..origin/main)

    if [ "$AHEAD" -eq 0 ] && [ "$BEHIND" -gt 0 ] && git merge-base --is-ancestor main origin/main; then
        echo ""
        echo "🔄 GitHub a $BEHIND commit(s) d'avance ; synchronisation sans fusion..."
        # Le contenu local de chaque fichier MODIFIÉ est le contenu voulu :
        # conserver un checkpoint avant de mettre à jour l'historique.
        checkpoint=""
        modified_paths=()
        new_paths=()
        if [ -n "$(git status --porcelain)" ]; then
            mapfile -d '' -t modified_paths < <(git -c diff.renames=false diff --name-only -z HEAD)
            mapfile -d '' -t new_paths < <(git ls-files --others --exclude-standard -z)
            git stash push --include-untracked -m "push.sh : sauvegarde locale avant synchronisation"
            checkpoint=$(git rev-parse 'stash@{0}')
            echo "🔒 Copie de sécurité des fichiers locaux : $checkpoint"
        fi
        if ! git merge --ff-only origin/main; then
            echo ""
            if [ -n "$checkpoint" ]; then
                git stash apply "$checkpoint" || true
                echo "Tes modifications sont aussi récupérables dans le checkpoint $checkpoint."
            fi
            echo "❌ Synchronisation impossible ; rien n'a été publié."
            exit 1
        fi
        if [ -n "$checkpoint" ]; then
            # Restaurer LES FICHIERS modifiés depuis la sauvegarde, et non un
            # merge textuel qui pourrait mêler deux versions d'index.html.
            if [ "${#modified_paths[@]}" -gt 0 ]; then
                git restore --source="$checkpoint" --staged --worktree -- "${modified_paths[@]}" || {
                    echo "❌ Restauration incomplète ; checkpoint conservé : $checkpoint"
                    exit 1
                }
            fi
            if [ "${#new_paths[@]}" -gt 0 ]; then
                git restore --source="$checkpoint^3" --worktree -- "${new_paths[@]}" || {
                    echo "❌ Restauration des nouveaux fichiers incomplète ; checkpoint : $checkpoint"
                    exit 1
                }
            fi
            echo "✅ Dernière version locale des fichiers modifiés rétablie."
        fi
        echo "✅ Historique GitHub conservé ; aucun push forcé."
    elif [ "$BEHIND" -eq 0 ] && [ "$AHEAD" -gt 0 ] && git merge-base --is-ancestor origin/main main; then
        echo "📌 $AHEAD commit(s) local(aux) déjà prêts à publier."
    else
        echo ""
        echo "⚠️ Historique local et GitHub divergents."
        echo "   📱/💻 Local  : $AHEAD commit(s) d'avance"
        echo "   ☁️ GitHub    : $BEHIND commit(s) d'avance"
        echo "❌ Publication annulée : fusion ou rebase à résoudre manuellement."
        exit 1
    fi
fi

# --------------------------------------------------
# 5. Afficher les modifications
# --------------------------------------------------

echo ""
echo "📦 Préparation des fichiers..."
echo ""

git status --short

if [ -z "$(git status --porcelain)" ]; then
    echo ""
    if [ "$(git rev-list --count origin/main..main)" -gt 0 ]; then
        echo "📌 Aucun fichier à modifier, mais des commits locaux sont à publier."
        git fetch origin
        if ! git merge-base --is-ancestor origin/main main; then
            echo "❌ GitHub a changé entre-temps ; aucun push effectué."
            exit 1
        fi
        git push -u origin main
        echo "✅ Commits locaux publiés."
        exit 0
    fi
    echo "ℹ️ Aucune modification à publier."
    exit 0
fi

echo ""
# --------------------------------------------------
# 6. Ajouter les fichiers
# --------------------------------------------------

git add -A

echo "Résumé :"
git diff --cached --stat

# Vérification finale des conflits après git add
if git diff --cached --name-only | grep -q .; then

    if git diff --cached | grep -q -E '^(<<<<<<<|=======|>>>>>>>)'; then
        echo ""
        echo "❌ Un marqueur de conflit est présent dans les fichiers."
        echo "Les fichiers préparés restent disponibles dans l'index Git."
        exit 1
    fi

fi

# --------------------------------------------------
# 7. Message du commit
# --------------------------------------------------

echo ""
read -p "💬 Message du commit [Mise à jour] : " MESSAGE

if [ -z "$MESSAGE" ]; then
    MESSAGE="Mise à jour"
fi

# --------------------------------------------------
# 8. Commit
# --------------------------------------------------

echo ""
echo "💾 Création du commit..."

git commit -m "$MESSAGE"

# --------------------------------------------------
# 9. Dernière vérification avant push
# --------------------------------------------------

echo ""
echo "🔎 Dernière vérification..."

git fetch origin

LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "❌ Erreur : le commit local n'est pas différent de GitHub."
    exit 1
fi

# GitHub doit être exactement le parent de notre commit
if ! git merge-base --is-ancestor origin/main main; then
    echo ""
    echo "❌ GitHub a changé pendant la publication."
    echo "Publication annulée pour éviter d'écraser une version distante."
    exit 1
fi

# --------------------------------------------------
# 10. Push
# --------------------------------------------------

echo ""
echo "☁️ Publication sur GitHub..."

git push -u origin main

echo ""
echo "=================================================="
echo "        ✅ PUBLICATION TERMINÉE"
echo "=================================================="
