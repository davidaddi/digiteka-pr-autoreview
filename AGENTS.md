# Installer ceci, pour un agent IA

Vous configurez ça sur la machine de quelqu'un. Lisez tout le fichier avant de lancer quoi que
ce soit.

Votre objectif : l'utilisateur commente `/review` sur une de ses pull requests et reçoit une
revue en retour.

## Ce que c'est

Un relecteur de code qui tourne sur la machine de l'utilisateur. Deux processus font le travail :

- **hermes** reçoit la commande, distribue, et publie. Ne lit jamais le code.
- **claude** fait la lecture, ouvre les fichiers, lance les tests, écrit les findings.

Rien n'est déployé. Aucune clé API n'est utilisée. Les deux tournent sur des logins par
abonnement.

## Étape 1. Vérifier les cinq binaires

```bash
for b in node gh cloudflared hermes claude; do printf '%-12s ' "$b"; command -v $b || echo MISSING; done
```

Si l'un manque :

| Binaire | Installation |
| --- | --- |
| `node`, `gh`, `cloudflared` | `brew install <name>` sur macOS, le paquet de la distro ailleurs |
| `hermes` | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` |
| `claude` | `npm install -g @anthropic-ai/claude-code` |

`hermes` et `claude` s'installent dans `~/.local/bin`, souvent absent d'un `PATH` non
interactif. Exportez-le avant tout le reste :

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Puis vérifiez que l'utilisateur est connecté aux deux. `claude` a besoin d'un login interactif
que vous ne pouvez pas faire à sa place — demandez-lui de lancer `claude` une fois si
`~/.claude/.credentials.json` n'existe pas.

## Étape 2. Donner un cerveau à hermes

Vérifiez ce qui est configuré. **La clé est `model.provider`, pas `provider`:**

```bash
hermes config get model.provider
```

Si ça affiche `auto`, une erreur, ou rien, hermes n'a pas de cerveau utilisable. Il ne fait que
distribuer, donc un petit modèle suffit et une revue complète coûte quelques centimes. Demandez
à l'utilisateur de lancer **une** de ces commandes, jamais les deux :

```bash
hermes auth add openrouter --type api-key    # demande la clé, l'écrit dans ~/.hermes/.env
hermes model                                 # ou un abonnement OAuth qu'il a déjà
```

Puis :

```bash
hermes config set model.provider openrouter
hermes config set model.default moonshotai/kimi-k2.6
```

**Ne pointez pas** hermes vers Anthropic. Ce chemin a besoin de Claude Max plus des crédits
achetés en plus, exclut Pro, et ne puise pas dans l'allocation Max. Garder hermes sur un
fournisseur différent coûte moins cher et évite que les deux côtés se battent pour un seul
quota.

Si la machine fait déjà tourner hermes pour autre chose, ne touchez pas du tout à sa config.
Passez le cerveau par exécution à la place :

```bash
export HERMES_PROVIDER=openrouter HERMES_MODEL=moonshotai/kimi-k2.6
```

## Étape 3. Le lancer

```bash
gh repo create my-sandbox --template iFeyz/hermes-pr-review --public --clone
cd my-sandbox
./setup-demo.sh
```

`setup-demo.sh` reste en avant-plan et affiche ses étapes. Il termine sur `Ready.` et l'URL
d'une pull request. Dites à l'utilisateur de commenter `/review` là-bas, et de laisser le
terminal ouvert.

Sur un repo existant, avec persistance après reboot (EC2, machine sans surveillance) :

```bash
REPO=owner/name ./setup.sh
```

`./setup.sh` finit en passant la main à `systemd --user` : plus besoin de laisser un terminal
ouvert après le premier lancement. Voir [README.md](README.md#2-installation) pour le détail
des six étapes et [ops/README.md](ops/README.md) pour la chaîne systemd complète.

## Étape 4. Confirmer que ça marche

En moins d'une seconde après le commentaire, une réaction 👀 apparaît sur lui. C'est le
receveur qui accuse réception.

Puis attendez. Une revue prend environ **15 minutes** sur 350 lignes changées. C'est normal,
ça lit le code plutôt que de survoler le diff. Ne relancez rien pendant ce temps.

Vous pouvez suivre la progression depuis un autre shell :

```bash
journalctl --user -u hermes-receiver -f     # si géré par systemd (./setup.sh)
ls -la runs/.pr.diff runs/.findings.json     # le diff d'abord, les findings à la fin
```

## Les échecs que vous allez vraiment rencontrer

| Symptôme | Cause | Quoi faire |
| --- | --- | --- |
| `Port 8787 is already taken` | un lancement précédent a laissé un tunnel/receveur (`setup-demo.sh`) | tuer ce pid, ou `PORT=8790 ./setup-demo.sh` |
| `Hermes has no provider yet` | étape 2 pas faite | faire l'étape 2 |
| rien ne se passe après `/review` | le webhook n'arrive pas jusqu'à la machine | vérifier les livraisons du webhook sur GitHub/GitLab, chercher un 502 |
| `command not found: hermes` | `~/.local/bin` absent du PATH | l'exporter, voir l'étape 1 |
| la revue est postée comme un simple commentaire | GitHub refuse les demandes de changement sur sa propre PR | attendu, c'est le comportement normal |
| le check est vert malgré un must-fix | `paths.blocking` pointe encore vers `demo/**` | le pointer vers le vrai code dans `review.config.yml` |

## À ne pas faire

- **Ne pas** afficher, échoter ou journaliser les tokens de l'utilisateur. `setup.sh` écrit
  `.runtime.<repo>-<pr>.env` en mode 600, n'y touchez pas.
- **Ne pas** modifier `~/.hermes/config.yaml` sur une machine qui fait déjà tourner hermes pour
  autre chose.
- **Ne pas** lancer deux `setup.sh`/`setup-demo.sh` sur le même port.
- **Ne pas** relancer une revue qui semble bloquée avant 40 minutes. Elle travaille probablement.
- **Ne pas** ajouter `--output-format json` à l'appel claude. Ça rend la commande silencieuse et
  hermes tue tout ce qui reste silencieux 60 secondes. Le code diffuse déjà (`stream-json`) pour
  cette raison.

## Les repos GitLab

Uniquement en mode webhook multi-repo (`src/provisioning-webhook/`), où un seul receveur sert
tous les repos de `repos.yml`. Les entrées GitHub et GitLab vivent dans le même fichier, sur le
même port, derrière le même tunnel :

```
davidaddi/demo:active                                github.com, l'orthographe par défaut
gitlab@gitlab.com:group/project:active               gitlab.com
gitlab@gitlab.digiteka.com:group/sub/project:active  auto-hébergé, sous-groupes compris

node src/provisioning-webhook/sync-repos.mjs add gitlab@gitlab.digiteka.com:group/sub/project
```

Deux choses à mettre dans `.env` avant cette commande, sinon elle échoue en nommant celle qui
manque :

| Variable | Pourquoi |
| --- | --- |
| `WEBHOOK_MULTI_SECRET_GITLAB` | une pour toutes les instances GitLab, jamais celle de GitHub : GitLab envoie le secret lui-même dans un en-tête sur chaque livraison |
| `GITLAB_TOKEN__GITLAB_COM`, `GITLAB_TOKEN__GITLAB_DIGITEKA_COM` | un PAT par instance, scope `api`. Le nom est l'hôte en majuscules, points et tirets en underscores |

Dites deux choses à l'utilisateur là-dessus. Commenter `/review` a besoin de **Developer ou
plus** sur le projet — le receveur vérifie via l'API et refuse tout ce qu'il ne peut pas
confirmer, ce qui inclut un Guest ou un inconnu. Et une revue GitLab revient comme **une seule
note de merge request**, tableau récapitulatif puis une ligne par finding, pas un commentaire
par ligne ; les discussions ancrées sur une ligne ne sont pas encore implémentées.

## Réglages qui valent le coup d'être changés

`review.config.yml`, le seul fichier que l'utilisateur édite :

| Clé | Effet |
| --- | --- |
| `model` | `claude-opus-5[1M]` lit en profondeur, `claude-sonnet-5` est environ 4x plus rapide |
| `agents` | en retirer un, il arrête de chercher cette classe de problème |
| `paths.blocking` | un must-fix sous ces chemins fait passer le check au rouge |
| `skeptics` | monter à 3, et un finding ne survit que sur une majorité |
| `max_findings` | plafond dur sur ce qui est publié |
