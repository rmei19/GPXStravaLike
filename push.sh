#!/bin/bash

set -e

export GIT_PAGER=cat
export PAGER=cat

clear

echo "=================================================="
echo "        🚀 PUBLICATION DU PROJET"
echo "=================================================="
echo ""

# --------------------------------------------------
# Vérification dépôt Git
# --------------------------------------------------

if [ ! -d ".git" ]; then
    echo "❌ Ce dossier n'est pas un dépôt Git."
    exit 1
fi

# --------------------------------------------------
# Vérification des conflits
# --------------------------------------------------

echo "🔎 Vérification des conflits Git..."

if grep -R -n -E '^(<<<<<<<|=======|>>>>>>>)' . \
    --exclude-dir=.git \
    --exclude=push.sh
then
    echo ""
    echo "❌ Des marqueurs de conflit Git ont été trouvés."
    echo "Corrige-les avant de continuer."
    exit 1
fi

echo "✅ Aucun conflit détecté."

# --------------------------------------------------
# Ajout des modifications
# --------------------------------------------------

echo ""
echo "📦 Préparation des fichiers..."

git add .

# --------------------------------------------------
# Vérification
# --------------------------------------------------

if git diff --cached --quiet; then
    echo ""
    echo "ℹ️ Aucune modification à publier."
    exit 0
fi

# --------------------------------------------------
# Affichage
# --------------------------------------------------

echo ""
echo "=================================================="
echo "        📝 MODIFICATIONS À PUBLIER"
echo "=================================================="
echo ""

git --no-pager status --short

echo ""
echo "Résumé :"
git --no-pager diff --cached --stat

# --------------------------------------------------
# Message du commit
# --------------------------------------------------

echo ""

DEFAULT="Mise à jour du $(date '+%d/%m/%Y à %H:%M')"

read -p "💬 Message du commit [$DEFAULT] : " MESSAGE

MESSAGE=${MESSAGE:-"$DEFAULT"}

# --------------------------------------------------
# Commit
# --------------------------------------------------

echo ""
echo "💾 Création du commit..."

git commit -m "$MESSAGE"

# --------------------------------------------------
# Synchronisation avec GitHub
# --------------------------------------------------

echo ""
echo "☁️ Vérification de GitHub..."

if ! git pull --rebase --autostash; then
    echo ""
    echo "❌ Impossible de synchroniser avec GitHub."
    echo ""
    echo "Un conflit doit probablement être résolu manuellement."
    echo "Le push est annulé."
    exit 1
fi

# --------------------------------------------------
# Vérification conflits après pull
# --------------------------------------------------

echo ""
echo "🔎 Vérification finale des conflits..."

if grep -R -n -E '^(<<<<<<<|=======|>>>>>>>)' . \
    --exclude-dir=.git \
    --exclude=push.sh
then
    echo ""
    echo "❌ Des marqueurs de conflit ont été détectés."
    echo "Le push est annulé."
    exit 1
fi

echo "✅ Aucun conflit détecté."

# --------------------------------------------------
# Push
# --------------------------------------------------

echo ""
echo "☁️ Envoi vers GitHub..."

git push

# --------------------------------------------------
# Fin
# --------------------------------------------------

echo ""
echo "=================================================="
echo "        ✅ PUBLICATION TERMINÉE"
echo "=================================================="
echo ""

echo "📌 Dernier commit :"
git --no-pager log -1 --oneline

echo ""
echo "🎉 GitHub est à jour."

echo ""
echo "🌍 Site :"
echo "https://rmei19.github.io/GPXStravaLike/"