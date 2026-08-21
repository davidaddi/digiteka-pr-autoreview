# Faire tourner le mode webhook au boot, sans surveillance

Ce dossier fait démarrer le mode webhook multi-repo (`src/provisioning-webhook/`) tout seul
quand une instance EC2 boote, dans le bon ordre, et refuse de démarrer quoi que ce soit quand
quelque chose manque.

Il ne touche pas à la démo ponctuelle (`setup-demo.sh`).

## Ce qui tourne, et ce qui n'a besoin que d'être installé

| | ce que c'est | comment ça tourne |
| --- | --- | --- |
| `cloudflared` | l'adresse publique sur laquelle GitHub/GitLab postent | tourne en continu, `hermes-tunnel.service` |
| `receiver.mjs` | écoute sur `127.0.0.1:$WEBHOOK_PORT`, distribue | tourne en continu, `hermes-receiver.service` |
| `hermes` | orchestre une revue | **pas un service.** Lancé à chaque livraison |
| `claude` | lit le code, écrit le correctif | **pas un service.** Lancé par `hermes` |

`hermes` et `claude` sont des CLI invoquées à chaque `/review`. Rien ne les fait tourner en
continu. Ce qui compte, c'est qu'ils soient installés, configurés et connectés *avant* que le
receveur n'accepte sa première livraison — c'est le rôle du preflight.

## La chaîne

```
hermes-preflight.service   oneshot   cette machine est-elle apte à servir ?
        |  Requires + After
hermes-tunnel.service      always    cloudflared, publie une url dans .tunnel.json
        |  ExecStartPost déclenche --> hermes-webhook-sync.service  oneshot
        |                              re-pointe chaque hook GitHub vers cette url
        |  Wants + After
hermes-receiver.service    always    node src/provisioning-webhook/receiver.mjs
```

Quatre décisions là-dedans valent d'être connues, parce que chacune devient un bug si on
l'inverse.

**Le preflight verrouille tout.** `Requires=` + `After=`, donc un check échoué laisse le
tunnel et le receveur `inactive dead`, pas « en train de tourner mais silencieusement
inutile ». Un token révoqué ou un hermes non configuré arrête la machine au boot, là où
quelqu'un le verra, plutôt qu'à 3h du matin sur une pull request que personne ne surveille.

**Le tunnel est cloudflared lui-même, pas un wrapper.** `ops/tunnel-run.sh` finit par un
`exec`, donc le processus que systemd supervise *est* cloudflared : `Restart=always` relance
la vraie chose et `$MAINPID` est réel. `src/provisioning-webhook/tunnel-lifecycle.mjs` n'est
pas modifié et fonctionne toujours à la main ; il se double-fork en arrière-plan, ce qui est
juste pour un shell qu'on va fermer et faux sous un superviseur. `ops/tunnel-ready.sh` écrit le
même `.tunnel.json` que ce script aurait écrit, donc `tunnel-lifecycle.mjs url|status`, la
console web et `sync-repos.mjs` continuent tous de fonctionner sans voir la différence.

**Le rafraîchissement du webhook est déclenché par le tunnel, pas par l'ordre de boot.**
`cloudflared tunnel --url` est un tunnel *quick* : Cloudflare émet un tout nouveau
`<random>.trycloudflare.com` à chaque démarrage. Après un crash, un redémarrage ou un reboot,
le tunnel est à une nouvelle adresse et chaque webhook que GitHub détient pointe vers un nom
d'hôte qui ne résout plus. GitHub ne prévient personne ; il enregistre des livraisons échouées
que personne ne lit. Le rafraîchissement doit donc tourner après *chaque* démarrage du tunnel,
et une dépendance ordinaire `Wants=`/`After=` ne se déclenche qu'une fois au boot.
`ExecStartPost` se déclenche aussi sur les redémarrages automatiques, c'est pour ça qu'il est
là. Mesuré sur un vrai crash : l'url a tourné et les hooks ont été re-pointés en quelques
secondes, sans humain dans la boucle.

**Un redémarrage du tunnel ne touche pas le receveur.** Le receveur a un `Wants=` sur le
tunnel, volontairement pas un `Requires=`. `Requires=` propage les redémarrages, et on a
observé que ça arrêtait le receveur chaque fois que cloudflared revenait — ce qui détruirait
une revue en cours, jusqu'à quarante minutes de travail de hermes et claude, à cause d'un
accroc de dix secondes sur quelque chose à qui le receveur ne parle même pas. Le receveur
écoute en loopback et ne se soucie pas de l'adresse du tunnel.

## `--user`, pas un service système

Ce sont des unités `systemd --user` tournant comme un utilisateur de login ordinaire, et elles
ont besoin du **lingering** activé pour démarrer au boot.

La raison, c'est `hermes` et `claude`. Les deux gardent leur état dans le dossier personnel
(`~/.hermes`, `~/.claude/.credentials.json`) et les deux sont connectés interactivement, une
fois, par un humain. Une unité système devrait reproduire à la main le `HOME`, les
identifiants et le PATH de cet humain, et chacun de ces éléments est un échec silencieux quand
il dérive. Tourner comme l'utilisateur qui s'est connecté élimine tout ce qu'il y aurait à
reproduire.

Le coût est une commande, sans laquelle rien ne démarre au boot :

```bash
sudo loginctl enable-linger $USER
```

Sans elle, le gestionnaire utilisateur n'existe que quand quelqu'un est connecté, et le
symptôme est le pire qui soit : tout fonctionne quand vous vous connectez en ssh pour vérifier,
et rien ne fonctionne à 4h du matin.

## Avant le premier boot : trois choses que seul un humain peut faire

Aucune de ces trois choses ne peut être automatisée, et les trois sont vérifiées par le
preflight.

1. **Un PAT GitHub.** Token classique avec le scope `repo` (équivalent fine-grained :
   Administration et Webhooks lecture/écriture sur les repos que vous enregistrez). Le mettre
   dans `.env` sous `GITHUB_TOKEN`.
2. **Configurer hermes**, en tant qu'utilisateur du service :
   ```bash
   hermes config set model.provider <provider>
   hermes config set model.name <model>
   ```
3. **Connecter claude**, en tant qu'utilisateur du service : lancer `claude` une fois,
   interactivement, et se connecter. Ça écrit `~/.claude/.credentials.json`. Il n'y a pas
   d'équivalent headless — sans ça, la première revue ouvre une invite de navigateur sur une
   machine sans navigateur et reste bloquée jusqu'au timeout de quarante minutes.

## Installation

Sur l'instance, en tant qu'utilisateur du service :

```bash
# 1. le checkout, où vous voulez -- rien ici ne fige un chemin en dur
git clone <repo> ~/hermes-pr-review && cd ~/hermes-pr-review

# 2. .env, mode 600, jamais commité. Il lui faut au moins :
#      GITHUB_TOKEN, WEBHOOK_MULTI_SECRET, WEBHOOK_PORT
#    WEBHOOK_MULTI_SECRET n'est volontairement pas WEBHOOK_SECRET : setup.sh régénère ce
#    dernier à chaque lancement, ce qui invaliderait silencieusement chaque hook créé ici.
install -m 600 /dev/null .env && $EDITOR .env

# 3. enregistrer au moins un repo (écrit repos.yml et crée le webhook)
node src/provisioning-webhook/sync-repos.mjs add <owner>/<name>

# 4. vérifier la machine avant d'installer quoi que ce soit
ops/preflight.sh

# 5. générer et installer les unités
ops/install-systemd.sh
sudo loginctl enable-linger $USER
systemctl --user enable --now hermes-webhook.target
```

`ops/install-systemd.sh` génère `ops/systemd/*.in` dans `~/.config/systemd/user/`. Il génère
plutôt que de faire des liens symboliques parce que deux choses ne peuvent être connues qu'au
moment de l'installation et ne peuvent pas s'exprimer dans un fichier d'unité :

- **où se trouve le checkout.** systemd n'étend pas les variables dans `WorkingDirectory=`,
  donc le chemin doit être littéral — mais il ne doit pas être littéral *dans git*, où il
  figerait le dossier personnel d'une personne. Chaque unité porte le chemin résolu dans un
  commentaire en haut.
- **où se trouvent les outils.** systemd ne lit ni `.bashrc`, ni `.profile`, ni le hook shell
  de nvm. Un service reçoit un PATH nu. L'installeur résout `node`, `cloudflared`, `hermes`,
  `claude`, `git` et `gh` dans le shell depuis lequel vous le lancez et écrit leurs dossiers
  dans `PATH=`. Lancez-le depuis un shell où ces commandes fonctionnent.

Ce dernier point a un piège qui vaut d'être dit clairement : **un vieux node de la distro va
masquer un plus récent.** Ubuntu 22.04 livre node 12 dans `/usr/bin`, Amazon Linux 2 livre le
10, et `/usr/bin` vient avant `~/.nvm` dans la plupart des PATH. `node -v` dans votre shell peut
dire 22 alors que le service reçoit le 12. Le preflight vérifie la version majeure, pas
seulement que `node` existe.

## Au quotidien

```bash
systemctl --user list-units 'hermes-*' --all     # l'état réel de tout le mode (alias herstat)
systemctl --user status hermes-receiver
journalctl --user -u hermes-receiver -f          # les revues au fur et à mesure
journalctl --user -u hermes-tunnel -n 50         # la sortie de cloudflared lui-même
journalctl --user -u hermes-preflight -n 40      # pourquoi il a refusé de démarrer
journalctl --user -u hermes-webhook-sync         # quand les hooks ont été re-pointés pour la dernière fois

systemctl --user restart hermes-webhook.target   # tout
systemctl --user start hermes-webhook-sync       # re-pointer les hooks à la main
node src/provisioning-webhook/sync-repos.mjs list # 'stale' = le hook est sur une vieille url (alias lr)
```

Journaliser est le travail de journald : chaque processus écrit sur stdout/stderr et systemd
s'en occupe. Il n'y a pas de fichier de log à faire tourner (rotate). `.tunnel.log` est
l'unique exception, et elle existe seulement parce que `tunnel-lifecycle.mjs` et la console web
extraient l'url de ce fichier.

## Désinstallation

```bash
ops/uninstall-systemd.sh
```

Arrête, désactive et supprime les unités. Laisse `.env`, `repos.yml`, `webhooks.json` et les
webhooks enregistrés sur GitHub/GitLab intacts — ça désinstalle la supervision, pas la
configuration. Ces hooks pointent maintenant vers un tunnel qui n'existe plus ; soit
réinstallez, soit supprimez-les proprement avec `sync-repos.mjs remove <owner>/<name>`. Ça
laisse aussi en place tout drop-in ajouté sous `hermes-*.service.d/`, puisque ce n'est pas ce
script qui l'y a mis.

## `ops/systemd.env`

Optionnel, gitignored, absent par défaut. Chaque unité le lit avec `EnvironmentFile=-`, donc
c'est l'endroit pour des valeurs propres à l'instance qui ne doivent pas être dans `.env`. Il
peut contenir des secrets ; ne jamais le commiter. Tout ici l'emporte sur `.env`, parce que
`loadEnv()` côté node et `env_value()` dans `ops/lib.sh` laissent tous les deux le vrai
environnement gagner sur le fichier.

Le plus utile pour `WEBHOOK_PUBLIC_URL`. Le pointer vers un tunnel cloudflared nommé avec une
vraie route DNS, et tout le problème de nom d'hôte qui tourne disparaît : `sync-repos.mjs`
utilise cette url plutôt que celle du tunnel quick, et le rafraîchissement après chaque
redémarrage devient un no-op. C'est ce qu'il faut faire pour tout ce qui dépasse un prototype.

## Les fichiers

| fichier | ce qu'il fait |
| --- | --- |
| `preflight.sh` | chaque vérification qui doit passer avant qu'une livraison soit acceptée |
| `lib.sh` | fonctions partagées ; lit `.env` avec exactement les règles de `loadEnv()`, ne le source jamais |
| `tunnel-run.sh` | `exec`ute cloudflared (ExecStart de l'unité tunnel) |
| `tunnel-ready.sh` | attend l'url, écrit `.tunnel.json` (ExecStartPost) |
| `webhook-sync.sh` | `sync-repos.mjs refresh` sous un verrou |
| `receiver-run.sh` | `exec`ute le receveur |
| `receiver-ready.sh` | interroge `/healthz` pour que « démarré » veuille dire « répond » |
| `install-systemd.sh` | génère et installe les unités |
| `uninstall-systemd.sh` | les arrête, les désactive et les supprime |
| `systemd/*.in` | les modèles d'unités |

`.env` est lu mais jamais `source`, il contient un token et un secret HMAC, et un backtick qui
s'y égare ne doit jamais devenir une commande.
