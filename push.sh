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
# 4. Vérifier que le dépôt est propre côté Git
# --------------------------------------------------

echo ""
echo "☁️ Vérification de GitHub..."

git fetch origin

# Vérifier si GitHub a avancé depuis notre dernière synchronisation
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then

    AHEAD=$(git rev-list --count origin/main..main)
    BEHIND=$(git rev-list --count main..origin/main)

    echo ""
    echo "⚠️ Les versions ont divergé."
    echo ""
    echo "   📱/💻 Local  : $AHEAD commit(s) d'avance"
    echo "   ☁️ GitHub    : $BEHIND commit(s) d'avance"
    echo ""
    echo "❌ Publication annulée."
    echo ""
    echo "Un autre appareil a probablement publié une version."
    echo "Synchronise d'abord manuellement avec GitHub."
    exit 1
fi

# --------------------------------------------------
# 5. Afficher les modifications
# --------------------------------------------------

echo ""
echo "📦 Préparation des fichiers..."
echo ""

git status --short

if git diff --quiet && git diff --cached --quiet; then
    echo ""
    echo "ℹ️ Aucune modification à publier."
    exit 0
fi

echo ""
echo "Résumé :"
git diff --stat

# --------------------------------------------------
# 6. Ajouter les fichiers
# --------------------------------------------------

git add .

# Vérification finale des conflits après git add
if git diff --cached --name-only | grep -q .; then

    if git diff --cached | grep -q -E '^(<<<<<<<|=======|>>>>>>>)'; then
        echo ""
        echo "❌ Un marqueur de conflit est présent dans les fichiers."
        git reset
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