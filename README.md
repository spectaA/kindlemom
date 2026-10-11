# Kindlemom

Gérer les livres d'une Kindle branchée en USB, directement dans le navigateur.
Les EPUB déposés sont convertis en **KFX** localement, puis copiés sur la Kindle.
Aucune installation, aucun serveur, aucun envoi de fichier.

## Utilisation

1. Ouvrir la page dans **Chrome** ou **Edge** (ordinateur).
2. Brancher la Kindle, cliquer sur « Connecter ma Kindle » et choisir le disque Kindle.
3. Déposer des EPUB. Renommer, remplacer ou supprimer depuis la bibliothèque.
4. Éjecter la Kindle.

## Fonctionnement

- Accès à la Kindle : File System Access API (Kindle vue comme une clé USB).
- Conversion EPUB → KFX : [boko](https://github.com/zacharydenton/boko), compilé en WebAssembly (`core/`).
- Couvertures : vignette écrite dans `system/thumbnails/` pour chaque KFX.
- `kindlemom.json` à la racine de la Kindle retient les vignettes créées.

## Développement

`web/` est le site statique, prêt à servir (le moteur compilé est dans `web/pkg/`).

    python3 -m http.server -d web 8000

Recompiler le moteur (Rust, cible `wasm32-unknown-unknown`, `wasm-bindgen-cli` 0.2.108) :

    ./build.sh

## Publication

Chaque push sur `main` publie `web/` sur GitHub Pages (dépôt public ;
activer une fois Settings → Pages → Source : GitHub Actions).

## Licence

GPL-3.0-or-later (comme boko). fflate : MIT.
