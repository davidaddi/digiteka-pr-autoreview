# hermes-pr-review — mode runner (self-hosted)

Revue de code par IA sur vos pull requests, via un runner GitHub Actions self-hosted. Vous
commentez `/review`, `/fix` ou `/revert`, un runner déclenche `hermes` + `claude`.

## Essai rapide, un repo

```bash
gh repo create my-sandbox --template iFeyz/hermes-pr-review --public --clone
cd my-sandbox
./setup.sh
```

Crée un tunnel `cloudflared` éphémère, un webhook GitHub, et un receveur local. Ctrl-C arrête
tout et supprime le webhook. Il faut `node`, `gh`, `cloudflared`, `hermes` et `claude` installés
et connectés (`setup.sh` dit ce qui manque).

## Plusieurs repos, une machine

Un runner self-hosted par repo (label `hermes-review`), tous partageant le même checkout :

```bash
cp .env.example .env
$EDITOR .env   # GITHUB_TOKEN (scopes repo + workflow)
node web/server.mjs      # http://127.0.0.1:8788
```

Tapez `owner/name`, cliquez **Add repository**. Ou sans l'interface :

```bash
node src/provisioning/sync-repos.mjs add owner/name
node src/provisioning/sync-repos.mjs list
node src/provisioning/sync-repos.mjs remove owner/name
```

`repos.yml` est le registre, `sync-repos.mjs` son seul écrivain.

## Poster comme `github-actions[bot]`, pas vous

GitHub refuse les demandes de changement sur votre propre pull request. Pour que le bot poste
à votre place :

1. Enregistrez un runner sur le repo, label `hermes-review`.
2. Copiez `workflow/review.yml` dans `.github/workflows/`, sur la branche par défaut.
3. Réglez les variables de repo `HERMES_PROVIDER` et `HERMES_MODEL`.

## Réglages

`review.config.yml` : `model`, `agents`, `paths.blocking`, `skeptics`, `max_findings`.

Aucune clé API : `hermes` et `claude` tournent sur des logins par abonnement.
