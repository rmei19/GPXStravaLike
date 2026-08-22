# 🚴 GPX Compare v3.0

GPX Compare est une application web légère, contenue dans un seul fichier HTML, permettant de visualiser, comparer et animer des traces GPX en 3D directement dans le navigateur.

## ✨ Fonctionnalités Principales

* **Glisser-Déposer intuitif :** Charge un ou plusieurs fichiers `.gpx` simultanément.
* **Comparaison multi-traces :** Alterne facilement entre différentes traces. Trie-les manuellement, par nom, distance ou dénivelé positif (D+).
* **Profil Altimétrique Interactif :** Visualise le dénivelé et clique n'importe où sur le graphique pour y déplacer instantanément le curseur sur la carte.
* **Lecture Animée :** Fais défiler ton parcours avec des contrôles de lecture (Play/Pause, Avance/Retour rapide) et ajuste la vitesse (x1, x2, x5, x10).
* **Rendu 3D et Relief :** Profite d'un rendu topographique réaliste grâce aux données de terrain MapTiler (Terrain-RGB).
* **Modes de Caméra Intelligents :**
  * `🎯 Seuil (25°)` : La caméra suit doucement les grands virages.
  * `🌀 Fluide` : La caméra suit le point avec une interpolation continue.
  * `🔒 Fixe (Nord)` : Maintient l'orientation vers le Nord.
  * `🚫 Libre` : Garde le contrôle total de la caméra pendant l'animation.
* **Export Vidéo (Natif) :** Enregistre ta lecture animée au format `.webm` directement depuis le navigateur, sans logiciel tiers.
* **Fonds de carte dynamiques :** Bascule entre Rando, Satellite, Topo et Route sans perdre tes données affichées.

## 🛠️ Configuration & Utilisation

1. **Installation :** Aucun serveur n'est requis. Ouvre simplement le fichier `index.html` dans un navigateur web moderne (Chrome, Firefox, Edge, Safari).
2. **Clé API MapTiler :**
   * L'application nécessite une clé API gratuite de [MapTiler](https://www.maptiler.com/) pour charger les fonds de carte et le modèle d'élévation 3D (DEM).
   * Au premier lancement, une fenêtre te demandera de saisir cette clé.
   * Elle est stockée localement dans ton navigateur (`localStorage`) et peut être modifiée via le bouton **🔑 Clé API**.

## 🚀 Nouveautés de la v3.0

* **Persistance des tracés :** Correction du bug de disparition des lignes GPX et du curseur lors du changement de fond de carte (Satellite, Topo, etc.).
* **Stabilité renforcée :** Fiabilisation du chargement des styles MapLibre, en particulier pour la vue Satellite qui posait des soucis de validation de clé API.

## 💻 Technologies Utilisées

* HTML5 / CSS3 / JavaScript (Vanilla)
* [MapLibre GL JS](https://maplibre.org/) - Rendu cartographique WebGL.
* [MapTiler](https://www.maptiler.com/) - Fournisseur de tuiles vectorielles et raster (Relief 3D).
