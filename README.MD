# 🚴 GPX Compare & 3D Flythrough

**GPX Compare** est une application web légère, réactive et zéro-dépendance (client-side uniquement), conçue pour visualiser, comparer et animer des sorties sportives (vélo, randonnée, trail) à partir de fichiers GPX.

## ✨ Fonctionnalités

- 📂 **Comparaison multi-tracés :** Importation simultanée de plusieurs fichiers GPX par sélection ou glisser-déposer.
- ⛰️ **Vue relief 3D & cartes vectorielles :** Support des cartes MapTiler (Rando, Satellite, Topo, Route) avec exagération du relief 3D.
- 📈 **Profil altimétrique interactif :** Visualisation du dénivelé avec suivi de position synchrone sur le canvas.
- 🎯 **Caméra intelligente :** Modes de suivi de caméra orientables (Seuil dynamique à 25°, suivi fluide, Nord fixe, libre).
- 🎬 **Export Vidéo WebM :** Génération fluide image par image d'un survol vidéo 3D du parcours.
- 📱 **Interface Mobile-First :** Ergonomie pensée pour smartphone avec tiroir rétractable pour la liste des sorties.
- 🌙 **Thèmes d'affichage :** Support automatique du mode Sombre/Clair selon les préférences système.

## 🚀 Utilisation rapide

1. Récupère une clé API gratuite sur [MapTiler](https://www.maptiler.com/).
2. Ouvre l'application `index.html` dans ton navigateur.
3. Renseigne ta clé API via le bouton **🔑 Clé API** (elle sera sauvegardée localement dans ton navigateur).
4. Glisse tes fichiers `.gpx` pour lancer la comparaison.

## 🛠️ Technologies utilisées

- **HTML5 / CSS3 / JavaScript (ES6+)**
- [MapLibre GL JS](https://maplibre.org/) pour le rendu cartographique WebGL.
- API web natives : **Canvas HTML5**, **MediaRecorder API** (capture vidéo client).

## 📄 Licence

Ce projet est sous licence MIT.
