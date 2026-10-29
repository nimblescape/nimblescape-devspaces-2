# Remote host for many students

Design proposal of 2026-10-29. Nothing of it is built yet.

## Purpose

This doc is about one Linux host with full root access that serves many students as their remote Docker host. How the window of a student reaches the host (one SSH login, the start script, the relay and the Docker pipe) is in the route B doc, [Remote devspaces with one SSH login](remote-devspaces-one-ssh-login.md). Hannes asked on 2026-10-29 to keep the management of the remote host in this separate doc.

The setup: each student has an own Linux user with an own rootless Docker Engine. Each student runs several dev containers of the same image, and each dev container runs its own VS Code server. This doc answers two questions:

- How do the students share the RAM and the disk of the host, so that the same files are not stored, downloaded and loaded once per student?
- How does a student get access to the host (onboarding), and how does the access end?

Nothing of this is built yet; there is no code change.

## Sharing RAM and disk on the host

### Where the memory goes

Linux shares RAM between processes without any setting when they read or run the **same file** (the same inode): the kernel keeps its pages once in the page cache, for all users and all containers. Two copies of the same file in two places are two files, and the kernel keeps both.

- **File pages, shareable:** the `node` program and the JavaScript of the VS Code server, its built-in extensions (TypeScript among them), and the programs of the image.
- **Process memory, not shareable:** the heap of each VS Code server, each extension host, each language server (for example tsserver) and each program of the student. Each window has its own. This is most of the RAM of a window, and no layout of Docker changes it: one shared engine needs it as much as one engine per student.

What one engine per student adds on top:

- the daemons of the engine (dockerd, containerd, rootlesskit and its network helper), while the engine runs;
- the Monitor of the engine (one Node.js process), while it runs;
- a second copy of each file in use, when each engine has its own copy of it.

Measured: the VS Code server 1.144.0 for linux-x64 is a 224 MB download and 641 MB unpacked (`node` 122 MB, built-in extensions 271 MB, `node_modules` 238 MB). Not measured: the RAM of a window and of an idle engine. A test on the host shows both (`smem`, or the PSS in `/proc/<pid>/smaps_rollup`).

### What Devspaces shares today, per engine

Each engine has one store volume, `devspaces-vscode`, for the VS Code servers and the extension packages ([architecture.md L148-L153](https://github.com/nimblescape/devspaces-vscode-2/blob/main/docs/architecture.md?plain=1#L148-L153)). Only the worker and the Monitor write it. Each dev container mounts it read-only at `/opt/devspace/vscode` ([names.ts L251-L272](https://github.com/nimblescape/devspaces-vscode-2/blob/main/src/core/names.ts#L251-L272)), and the server runs from a link into it ([vscodeServerLink.ts L5-L13](https://github.com/nimblescape/devspaces-vscode-2/blob/main/src/core/worker/vscodeServerLink.ts#L5-L13)). So all dev containers of one student run the same server files: once on disk and once in RAM. The dev containers of one image also share the layers of that image. The Marketplace extensions are copied as `.vsix` into each container and installed there ([vscodeExtensionSeed.ts L5-L11](https://github.com/nimblescape/devspaces-vscode-2/blob/main/src/core/worker/vscodeExtensionSeed.ts#L5-L11)), so their files exist once per container.

With one rootless engine per student, each student has an own store and an own copy of each image. With 30 students and about two server versions in each store, the host keeps about 30 × 1.3 GB = 38 GB of servers, downloads 30 × 224 MB = 6.7 GB at each VS Code update, and loads the same server files 30 times into RAM.

### Proposal: one VS Code store on the host for all students

The host keeps one store, and the engines of all students mount it read-only. This answers the case "each Docker runs the same VS Code server".

1. Root creates a folder, for example `/srv/devspaces/vscode`, that only one service user writes (for example `devspaces-store`), with mode 0755. Every student can read it; no student can write it.
2. The service user keeps the store up to date: the newest stable server and the extensions, as the Monitor does today.
3. In the engine of each student, the volume `devspaces-vscode` is a bind volume of that folder, created by the setup of the host: `docker volume create --driver local --opt type=none --opt o=bind --opt device=/srv/devspaces/vscode devspaces-vscode`.
4. Devspaces recognizes a store that the host provides and only reads it: the worker and the Monitor of a student download nothing into it, take no lock in it and remove nothing from it. The dev containers mount it read-only as today, and the link works as today.
5. When the store has no server for the VS Code of a student (another commit), the open goes on as today: the Dev Containers extension installs the server into the container ([architecture.md L152](https://github.com/nimblescape/devspaces-vscode-2/blob/main/docs/architecture.md?plain=1#L152)).

Result: each server once on disk, one download per update, and the server files once in RAM for all students. In the containers, the files show the owner `nobody`, because the service user is not part of the user namespace of a student's engine; reading and running them works.

Open points: step 4 and the list of the servers and extensions that the opens of all students need (today each Monitor learns it from the opens on its own engine) are changes in Devspaces; a bind volume in a rootless engine needs a test.

### Images

Docker has no image store that several engines share. Each rootless engine downloads, stores and loads each image itself.

- **Disk:** a file system with deduplication stores equal blocks once, for example Btrfs (a storage driver of rootless Docker, [troubleshoot.md L67-L70](https://github.com/docker/docs/blob/main/content/manuals/engine/security/rootless/troubleshoot.md?plain=1#L67-L70)) with `duperemove`. It saves disk only: the copies are still different files, so the RAM is not shared.
- **Download:** the Docker setting `registry-mirrors` mirrors only Docker Hub ([mirror.md L36-L37](https://github.com/docker/docs/blob/main/content/manuals/docker-hub/image-library/mirror.md?plain=1#L36-L37)), and the classroom images come from ghcr.io. A job of the host can pull an image once and load it into each engine (`docker save`, then `docker load` as the student). Whether the Monitor then sees that image as current needs a test.
- **RAM:** only one engine shares the files of an image in RAM. Podman can give all users one read-only image store (`additionalimagestores`, [containers-storage.conf.5.md L84-L85](https://github.com/containers/storage/blob/main/docs/containers-storage.conf.5.md?plain=1#L84-L85)), but Devspaces does not support Podman ([guide.md L10](https://github.com/nimblescape/devspaces-vscode-2/blob/main/docs/guide.md?plain=1#L10)).

The programs of the image that a student runs (for example the `node` of the image for a dev server) are loaded once per engine. The VS Code server and its language servers run from the store, so the shared store above covers them.

### Memory savers for the process memory

These work with one engine per student. Root sets them up once.

- **Run only what is in use.** Without lingering, systemd stops the user's services, and with them the rootless engine and its containers, 10 seconds after the last login of the student ends ([logind.conf.xml L189-L196](https://github.com/systemd/systemd/blob/main/man/logind.conf.xml#L189-L196)). In route B each open window keeps one SSH login. So a student without a window uses no RAM. The cost: no Monitor at night, so no prepare before the lesson. With lingering ([tips.md L23-L27](https://github.com/docker/docs/blob/main/content/manuals/engine/security/rootless/tips.md?plain=1#L23-L27)) the engine runs all the time; then **Stop When Closed** (`devspaces.stopOnClose`) stops a devspace when its window closes.
- **Fair share.** A drop-in `/etc/systemd/system/user-.slice.d/resources.conf` applies to every user ([user@.service.xml L82-L84](https://github.com/systemd/systemd/blob/main/man/user@.service.xml#L82-L84)). `MemoryHigh=` slows down a student who uses more and takes memory from that student first; `MemoryMax=` is a hard limit ([systemd.resource-control.xml L366-L374](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml#L366-L374)). Nothing is reserved: memory that one student does not use is free for the others.
- **Compress idle memory.** zswap keeps pages that would go to swap compressed in RAM ([zswap.rst L7-L12](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/mm/zswap.rst?plain=1#L7-L12)). Idle windows of students are a good case for it. It needs a swap device.
- **KSM: only after a measurement, and only if the risk is accepted.** Kernel samepage merging joins equal pages of process memory; it merges only anonymous pages, never file pages, which the page cache already shares ([ksm.rst L25](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/mm/ksm.rst?plain=1#L25)). KSM is a setting of the host only; images, containers, Docker and Devspaces need no change. Setup for all students (Linux 6.4 or later, systemd 254 or later; Debian 13 and Ubuntu 24.04 have both): a drop-in `/etc/systemd/system/user@.service.d/ksm.conf` with `[Service]` and `MemoryKSM=yes`, and `echo 1 > /sys/kernel/mm/ksm/run` (the default is 0, and without it nothing is merged). The kernel passes the setting to each child process and keeps it across exec ([mm\_types.h L2033-L2035](https://github.com/torvalds/linux/blob/master/include/linux/mm_types.h#L2033-L2035), [vma\_exec.c L135](https://github.com/torvalds/linux/blob/master/mm/vma_exec.c#L135)), so the rootless engine, its containers and each VS Code server of the student are included. Gain: unknown. A V8 heap holds addresses that differ in each process, so most heap pages differ; `/sys/kernel/mm/ksm/general_profit` shows the real saving. Cost: CPU for the scanner ksmd (the scan-time advisor limits it to 70 % of one CPU by default, [ksm.rst L177-L179](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/mm/ksm.rst?plain=1#L177-L179)); a merged page is copied again when a process writes it, so the memory can grow back fast, and the RAM of the host must not be planned with the saving. Risk: KSM merges the pages of all users and cannot be limited to the pages of one student. A write to a merged page takes longer, so a student can test whether the memory of another student holds a page with a content that the student knows. Published attacks used this, for example Flip Feng Shui (USENIX Security 2016) together with Rowhammer. For this reason the systemd documentation says to enable it "only for jobs that share the same security domain" ([systemd.exec.xml L2198-L2211](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml#L2198-L2211)).

  With the onboarding of the next section, only known students of the course reach the host, each login belongs to one person, and access ends at once. This makes the risk smaller, but it does not remove it: a timing test leaves no trace in a log. For a course host with a large measured gain, accepting the risk is reasonable; for an exam host, keep KSM off.

### The other way: one engine for all students

One rootful engine stores each image once and shares its files in RAM. But Docker's documentation says that "only trusted users should be allowed to control your Docker daemon" ([security/\_index.md L89-L96](https://github.com/docker/docs/blob/main/content/manuals/engine/security/_index.md?plain=1#L89-L96)): whoever reaches its socket controls all containers and, through a mount of `/`, the host. In route B the Docker pipe gives the VS Code of each student the socket, so every student could open the devspaces of the others. The relay could filter the Docker API per student, but that is a large part with a high security risk. I do not recommend it.

### Recommendation for sharing

One rootless engine per student, the shared VS Code store on the host, `MemoryHigh` per user and zswap. Lingering depends on whether a prepare before the lesson matters more than the RAM of idle engines. Before more planning, a test with three students on the host measures the RAM of a window (PSS), the RAM of an idle engine, and the gain of the shared store.

## Onboarding and management of the host

Hannes's idea: a student signs in to a management page. The page checks who the student is, and then gives the student access to the remote host by managing the OpenSSH keys. With this, a managed host needs no password, no question about the host key and no key offer in the start script. A host without a management page keeps the login of [Login without setup](remote-devspaces-one-ssh-login.md#login-without-setup) in the route B doc.

### The parts

| Part | Where | What it does |
| --- | --- | --- |
| Management page | a web service with HTTPS, new, separate from the extension | Signs the student in (GitHub, or the identity of the school). Checks that the student belongs to the course. Keeps the student, the host, the Linux user and the keys of each computer. Shows the keys by computer name, so a student or the teacher can remove one (for example of a lost laptop). |
| Host service | on each host; a root part with fixed actions only, and a part without root | Works with the page (below). Creates the Linux user, its entries in `/etc/subuid` and `/etc/subgid`, its rootless Docker Engine and the bind volume of the shared VS Code store. Writes the keys of each user for sshd. Locks and later removes the user at the end of the course. |
| sshd | on the host | Takes the keys of a user only from the files of the host service. |
| Devspaces | on the computer of the student | Creates the key of the computer, registers it through the page (below), and then opens devspaces with route B as before. |

### The service on the host

The automation needs one service on each host that works with the central page.

- **The host connects out.** The host service connects to the page over HTTPS; the page never connects to the host. So the host opens no port other than SSH, and the page holds no root access to the host. The host service proves itself to the page with a key of its own, for example a client certificate.
- **Desired state, not commands.** For each host, the page publishes the list of its users (active, locked or removed) with their keys. The host service compares that list with the host and makes the host match it, at each run and in the same way. A missed message does no harm, because the next run corrects it.
- **Two parts.** The root part does only the fixed actions of the life of a user (next section). The part without root writes the keys of each user into the files that sshd reads, so logins still work while the page does not answer.
- **Own limits.** The host service changes only accounts that match its name pattern (for example `gh-<id>`), never other accounts of the host, and refuses every action outside its fixed list. A page that someone broke into then cannot take over other accounts or run commands on the host.
- **It reports back.** It sends the state of each user (created, engine ready, locked) to the page, so the page can show the teacher who is ready.

### The life of a student's Linux user

The management page also manages the Linux users of the host; it does this only through the host service.

1. **Create, at the enrollment.** The page chooses the host and adds the student to its list. The host service runs `useradd` with the name from the page, without a password, with a home folder of mode 0700 and a disk quota. When `/etc/subuid` exists, `useradd` also gives the user a range of subordinate IDs. The user must exist before the first login, because sshd checks keys only for users that exist ([sshd\_config.5 L322](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L322)).
2. **The engine, without a step per user.** One user unit for all users, `/etc/systemd/user/docker.service` with `dockerd-rootless.sh`, enabled with `systemctl --global enable docker`, starts the rootless engine at the first login of each user. This needs a test; the documented way is `dockerd-rootless-setuptool.sh install` as each user.
3. **During the course.** Keys come and go on the page; on the host, only the key files change.
4. **Lock, at the end of the course.** The host service locks the account (`usermod --lock --expiredate 1`), ends its processes (`loginctl terminate-user`) and empties its key file.
5. **Remove, after a time to keep.** For example after 30 days, so a student can still copy work that is not pushed: `userdel --remove` (the home folder holds the data of the engine), and the entries in `/etc/subuid` and `/etc/subgid` go too.

With several hosts, the page records the host of each student and gives it in the answer of the enrollment. A school with a directory service (LDAP, Active Directory) can give the users to the host through SSSD instead of `useradd`; the subordinate IDs and the engine still need the host service, so this saves little.

### sshd takes the keys from the host service

```
AuthorizedKeysFile /etc/ssh/devspaces-keys/%u
PasswordAuthentication no
KbdInteractiveAuthentication no
DisableForwarding yes
PermitTunnel no
```

- The host service writes one file per user into `/etc/ssh/devspaces-keys/`, owned by root, in the format of authorized\_keys. `AuthorizedKeysFile` takes an absolute path with the token `%u` ([sshd\_config.5 L303-L322](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L303-L322)). sshd no longer reads `~/.ssh/authorized_keys`, so a student cannot add a key of another person to the own account.
- A key that the page removes stops working once the host service wrote the new list. While the page does not answer, the files keep the last list, so logins still work.
- `AuthorizedKeysCommand` is the other way: sshd asks a program at each login, for example a request to the page ([L266-L289](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L266-L289), [L290-L302](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L290-L302)). It needs no files, but no login works while the page does not answer. With the host service, the files are simpler.
- `DisableForwarding yes` ([L708-L713](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L708-L713)) and `PermitTunnel no` ([L1581](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L1581)) turn off all forwarding. Route B needs only `sh -s` on standard input and output.

### One click with Devspaces

1. The link of the teacher names the host and its management page (a new part of the course link, to be decided).
2. Devspaces creates an Ed25519 key for this computer. The private key never leaves the computer.
3. Devspaces opens the management page in the browser with OAuth 2.0 authorization code and PKCE, the method for apps on a computer ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252), [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)). The student signs in.
4. The page sends the browser back to VS Code with a one-time code, on a link of Devspaces such as the course link ([links.ts L7-L15](https://github.com/nimblescape/devspaces-vscode-2/blob/main/src/vscode/links.ts#L7-L15), [extension.ts L775](https://github.com/nimblescape/devspaces-vscode-2/blob/main/src/vscode/extension.ts#L775)).
5. Devspaces sends the code, its PKCE secret and the public key to the page. Only the Devspaces that started step 3 has the PKCE secret, so a link that another person sends cannot add a key of that person to the account of a student.
6. The answer names the Linux user, the host, the port and the host key. Devspaces writes the host key into its own known\_hosts file, so there is no question about the fingerprint; HTTPS of the page is the proof of the host key.
7. Devspaces waits until the host service reports the user as ready, adds the host to its own list of hosts and opens the devspace with one SSH login per window, as in [How a window opens](remote-devspaces-one-ssh-login.md#how-a-window-opens) of the route B doc.

With GitHub as the identity, the page uses its own GitHub OAuth app with a small scope (for example `read:org` for the membership in the course organization). Devspaces never sends its own GitHub token, which has the scope `repo`, to the page.

### Keys or certificates

|  | Key files of the host service | OpenSSH certificates |
| --- | --- | --- |
| How | the host service writes the keys of each user into a file on the host (above) | the page signs the public key for a time, for example one day or one term; sshd trusts only the key of the page (`TrustedUserCAKeys`, [L2062-L2076](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L2062-L2076); [ssh-keygen.1 L919-L935](https://github.com/openssh/openssh-portable/blob/master/ssh-keygen.1#L919-L935)) |
| Page down | logins work with the last list; new keys wait | logins work until the certificate ends |
| Remove access | at the next run of the host service | when the certificate ends; earlier only with a list of revoked keys (`RevokedKeys`, [L1906-L1912](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L1906-L1912)) |
| Several hosts | the page publishes the list of each host | one key of the page for all hosts; host certificates replace the host key per host (`@cert-authority` in known\_hosts, [sshd.8 L728-L740](https://github.com/openssh/openssh-portable/blob/master/sshd.8#L728-L740)) |
| Devspaces | registers the key once | must renew the certificate before it ends |

Recommendation: key files of the host service, because the host service exists anyway for the users. Certificates add little then. Existing products already do "sign in on a page, then get an SSH certificate", for example Smallstep step-ca; using one instead of an own page is an option, but the users and engines still need the host service.

### What the page changes in the route B doc

On a managed host, decisions 2 and 3 of [Decisions for Hannes](remote-devspaces-one-ssh-login.md#decisions-for-hannes) in the route B doc (confirm the host key once; offer a key without passphrase) are not needed, and the start script appends no key. A host without a management page keeps them.

### What the onboarding does not limit

The onboarding limits who reaches the host: only known students of the course, each login belongs to one person, access ends at once, and the page can ask each student to accept rules of use. It does not limit what a student does on the host. A student can run any dev container and any program with the rights of the own Linux user. The host access policy of Devspaces protects a student against a foreign repository; it does not protect the host against the student, because the student controls the own engine through the Docker pipe. Rootless Docker keeps root in a container equal to the student's user. Root sets up these limits on the host as well:

- **Resources per user:** `MemoryMax=`, `CPUQuota=` and `TasksMax=` in the drop-in for `user-.slice` ([systemd.resource-control.xml L232](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml#L232), [L571-L574](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml#L571-L574)), and a disk quota on `/home`, which holds the data of each rootless engine.
- **Network per user:** nftables rules on the user ID (`meta skuid`) allow outbound traffic only to GitHub, the registries, npm and the Marketplace, and nothing into the school network or to local services of the host, such as the host service. The network helper of rootless Docker runs as the student, so the rule sees the student's user ID; this needs a test.
- **Privacy between students:** `/proc` mounted with `hidepid=invisible`, so a student does not see the processes of others and their command lines ([proc.rst L2417-L2425](https://github.com/torvalds/linux/blob/master/Documentation/filesystems/proc.rst?plain=1#L2417-L2425)); home folders with mode 0700.
- **sshd without forwarding:** in the configuration above.
- **Kernel updates soon after release:** rootless Docker needs unprivileged user namespaces, and bugs of the kernel there are the main way out of a container.
- **KSM:** see [Memory savers for the process memory](#memory-savers-for-the-process-memory); off on an exam host.

### Open choices

- The identity: GitHub (each student has an account for Devspaces already) or the identity of the school.
- Key files or certificates.
- Where the page runs (on the host, or on another server), and who builds the page and the host service: a new repository of nimblescape, or an existing product.
- The name of the Linux user: from the stable GitHub user ID (a login can change), for example `gh-<id>`, or from the school account.
- How the host service proves itself to the page: a client certificate or a token.

## Strict isolation between students

The limits of [What the onboarding does not limit](#what-the-onboarding-does-not-limit) keep the students apart on one shared kernel. Three levels go further.

### Level 1: the same kernel, more walls

On a shared kernel, only the rules that root sets and the kernel enforces hold: users, file permissions, cgroups, nftables and mount options. A student has a shell and controls the own engine, so the student can change everything in the own files: the Docker settings, the systemd user units, the runtime of the containers. A runtime such as gVisor in the student's own engine therefore cannot be enforced; level 2 puts gVisor around the engine instead. Additions to the limits above:

- **Private temporary folders.** pam\_namespace gives each user own instances of `/tmp` and `/var/tmp` at the login, and of `/dev/shm` with the method `tmpfs` ([namespace.conf.5.xml L18-L30](https://github.com/linux-pam/linux-pam/blob/master/modules/pam_namespace/namespace.conf.5.xml#L18-L30), [L99](https://github.com/linux-pam/linux-pam/blob/master/modules/pam_namespace/namespace.conf.5.xml#L99)). Without it, all users share these folders.
- **No connections between students on the host.** nftables in the output chain drops TCP and UDP from the user IDs of the students (`meta skuid`) to the addresses of the host itself (loopback and its own IP addresses), with an exception for DNS when the host uses a local resolver. This blocks the ports that the engine of another student publishes (rootless Docker listens on the host as that student) and every local service. Dev Containers forwards ports through `docker exec`, not through TCP on the host, so a student needs no such connection. From the network, only SSH comes in. This needs a test.
- **Less information about the kernel, and less attack surface.** `kernel.dmesg_restrict=1` ([kernel.rst L253-L261](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/sysctl/kernel.rst?plain=1#L253-L261)), `kernel.kptr_restrict=2` ([L568-L580](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/sysctl/kernel.rst?plain=1#L568-L580)) and `kernel.unprivileged_bpf_disabled=1` ([L1661-L1680](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/sysctl/kernel.rst?plain=1#L1661-L1680)). Whether rootless Docker works without `bpf()` for users needs a test.
- **No KSM** (see [Memory savers for the process memory](#memory-savers-for-the-process-memory)).

The limit of level 1: one bug in the kernel can break all of these walls at once.

### Level 2: a gVisor sandbox for each student

Hannes asked on 2026-10-29 about a gVisor sandbox for each student, with the student's own Docker inside it. gVisor runs the programs of a container on its own kernel in user space, the Sentry. The host kernel sees only the Sentry, and every system call of a program has its own implementation in the Sentry ([security.md L182-L188](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/security.md?plain=1#L182-L188)). The Sentry itself uses only a small set of host system calls ([L153-L157](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/security.md?plain=1#L153-L157)).

Root runs one Docker engine of its own with the gVisor runtime `runsc`, and starts one sandbox for each student with a Docker Engine inside. gVisor supports Docker 27, 28 and 29 inside a sandbox ([docker-in-gvisor.md L13-L17](https://github.com/google/gvisor/blob/master/g3doc/user_guide/tutorials/docker-in-gvisor.md?plain=1#L13-L17)). The student uses only the inner engine and cannot change the outer one, so, unlike in level 1, the student cannot turn gVisor off. The sandbox starts with `--cap-add all`. This gives the inner `dockerd` the capabilities that it needs inside the sandbox, but no right on the host ([L110-L114](https://github.com/google/gvisor/blob/master/g3doc/user_guide/tutorials/docker-in-gvisor.md?plain=1#L110-L114)).

For Devspaces, route B stays the same:

1. sshd runs a gateway with `ForceCommand` instead of the command of the client; the command of the client is in `SSH_ORIGINAL_COMMAND` ([sshd\_config.5 L730-L744](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L730-L744)). The gateway is one fixed program that each student may run as root through one sudo rule. It takes the sandbox of the calling user (`SUDO_USER`) and runs the command of the client, `sh -s`, in it with `docker exec -i`. The students are not in the group `docker` of the outer engine.
2. The gateway starts the sandbox of the student when it does not run, and stops it some time after the last window of the student closed.
3. The start script, the relay and the Docker pipe work inside the sandbox as on any host. The inner engine runs as root of the sandbox, so the student needs no subordinate IDs and no rootless engine.
4. The host service creates and removes one sandbox and one data folder per student instead of a rootless engine on the host.

What it needs:

- **Network.** The inner `dockerd` needs the `runsc` flags `--net-raw` and `--allow-packet-socket-write`, and the second flag "allows sandboxed code to craft arbitrary network packets" ([L35-L47](https://github.com/google/gvisor/blob/master/g3doc/user_guide/tutorials/docker-in-gvisor.md?plain=1#L35-L47)). So each sandbox gets its own network on the outer engine, and nftables on the host keeps these networks apart from each other and from the host, as in level 1. Inside, `dockerd` runs with `--iptables=false`, so a published port of an inner container does not work ([L23-L28](https://github.com/google/gvisor/blob/master/g3doc/user_guide/tutorials/docker-in-gvisor.md?plain=1#L23-L28)). Dev Containers forwards ports through `docker exec` and does not need one. The start script of gVisor for the inner `dockerd` adds the NAT rules for outbound traffic ([start-dockerd.sh L55-L72](https://github.com/google/gvisor/blob/master/images/basic/docker/start-dockerd.sh#L55-L72)).
- **Image storage.** Docker 29 in gVisor needs a tmpfs at `/var/lib/docker` for overlayfs, or the classic storage drivers without the containerd image store ([L68-L89](https://github.com/google/gvisor/blob/master/g3doc/user_guide/tutorials/docker-in-gvisor.md?plain=1#L68-L89)). Without overlayfs, the classic driver is vfs ([start-dockerd.sh L45-L53](https://github.com/google/gvisor/blob/master/images/basic/docker/start-dockerd.sh#L45-L53)), which keeps a full copy of the files for each layer and each container.
- **Compatibility.** gVisor implements a large part of Linux, but not all of it, and "the only real way to know if it will work is to try" ([compatibility.md L5-L10](https://github.com/google/gvisor/blob/master/g3doc/user_guide/compatibility.md?plain=1#L5-L10)). The classroom images, the worker and the Monitor of Devspaces need a test.
- **Speed.** Programs compute at full speed ([performance.md L109-L125](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/performance.md?plain=1#L109-L125)), but file operations cost more ([L220-L232](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/performance.md?plain=1#L220-L232)), so `npm install`, Git and builds are slower. To measure.

The RAM, compared with the sharing goal of this doc:

- **Shared VS Code store: kept.** Root binds the host folder read-only into each sandbox. gVisor maps files of the host directly, and "this allows the same host memory to be shared across multiple sandboxes" ([resources.md L37-L45](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/resources.md?plain=1#L37-L45)). Whether this holds through the bind into the inner dev container needs a test.
- **Images: more RAM or more disk.** With the tmpfs, the images and containers of each student live in the memory of the sandbox, so in RAM or in swap: with 30 students and an unpacked image of 2 GB, at least 60 GB. With vfs, they take disk instead, a full copy for each layer and each container.
- **Process memory:** as in level 1, plus a small, mostly fixed amount for each sandbox ([performance.md L80-L107](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/performance.md?plain=1#L80-L107)).
- **KSM: no gain.** All program memory of a sandbox is one memfd ([resources.md L84-L86](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/resources.md?plain=1#L84-L86)), which the kernel counts as shared memory ([L128-L131](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/resources.md?plain=1#L128-L131)), and KSM merges only private anonymous pages ([ksm.rst L25](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/mm/ksm.rst?plain=1#L25)).
- **Fair share:** the memory limit of the outer engine (`docker run --memory`) works on the cgroup of each sandbox ([resources.md L123-L126](https://github.com/google/gvisor/blob/master/g3doc/architecture_guide/resources.md?plain=1#L123-L126)).

The limit of level 2: the Sentry runs on the host kernel. To reach the host, a student needs a bug in the Sentry and then a second bug in the host system calls that the Sentry uses. In level 3, a student needs a bug in the virtual machine monitor or in KVM instead.

### Level 3: an own kernel for each student

Each student gets a small virtual machine (VM) on the host, for example with Firecracker or Cloud Hypervisor (both use KVM). The rootless engine, the Monitor and the dev containers of the student run inside that VM. A student who breaks out of a container lands in the own VM, not on the host and not with other students.

For Devspaces, route B stays the same:

1. sshd on the host runs a gateway for each student with `ForceCommand`, instead of the command of the client; the command of the client is in `SSH_ORIGINAL_COMMAND` ([sshd\_config.5 L730-L744](https://github.com/openssh/openssh-portable/blob/master/sshd_config.5#L730-L744)).
2. The gateway starts the VM of the student when it does not run, and runs that command (`sh -s`) inside the VM, with standard input and output over vsock.
3. The start script, the relay and the Docker pipe work inside the VM as on any host.
4. The host service creates and removes one VM disk per student instead of a rootless engine on the host. The Linux user on the host only owns the SSH login.

The costs:

- **RAM:** each VM has an own kernel and an own page cache. The shared VS Code store can be one read-only disk image for all VMs; this saves disk, but each VM keeps its own copy of the files in its RAM. A balloon device can give unused memory of a VM back to the host (test).
- **Start time:** a small VM starts within seconds (to measure). The gateway stops a VM some time after the last window of the student closed.
- **Work:** the gateway and the VM image are new parts to build and to keep up to date.

### Recommendation for isolation

Level 1 on every host. When the students must be strictly separated, for example on an exam host, or when one host serves several schools, level 2 or level 3:

- **Level 2** needs no VM image and no Linux kernel of its own per student, and keeps the shared VS Code store once in RAM. But its images take RAM (tmpfs) or much disk (vfs), and gVisor does not run every program.
- **Level 3** keeps the images on the disk of each VM, and each VM runs every Linux program. But each VM has an own kernel and an own page cache.

The test with three students on the host decides between them: it runs the classroom image in both levels and measures the RAM, the disk and the time of `npm install`.

## Automatic setup of the host

Hannes runs the host on af.stack of Artfiles, an OpenStack cloud with a REST API, a command-line client and Ansible modules ([af.stack](https://www.artfiles.de/en/cloud/af-stack)). The setup of level 1 is automated in three layers, so that a second host or a rebuilt host is the same as the first.

### Layer 1: the server

OpenTofu with the OpenStack provider, or a Heat template, creates:

- the VM, with a flavor that has enough RAM for the planned number of students;
- a volume for `/home`, which holds the data of all rootless engines;
- a swap volume for zswap;
- a security group that lets in only SSH.

The server gets a short cloud-init file: it adds the key of the admin, installs Ansible and starts layer 2. Whether the images of af.stack run cloud-init needs a check; the standard cloud images of Debian and Ubuntu do.

### Layer 2: the configuration of the host

One Ansible playbook in a Git repository describes the whole host. Each run makes the host match it, so a second run changes nothing. The playbook:

- installs Docker Engine with `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session`, nftables and the quota tools, and gives no student access to the rootful engine (no member in the group `docker`);
- writes the global user unit `/etc/systemd/user/docker.service` and runs `systemctl --global enable docker`;
- writes `/etc/systemd/system/user-.slice.d/resources.conf` with `MemoryHigh=`, `MemoryMax=`, `CPUQuota=` and `TasksMax=`;
- writes the sshd drop-in of [sshd takes the keys from the host service](#sshd-takes-the-keys-from-the-host-service), and `/etc/security/namespace.conf` with pam\_namespace in the PAM files;
- writes the nftables rules of level 1 for the UID range of the students, for example 20000 to 29999; the host service creates students only in that range;
- sets the sysctls of level 1, mounts `/proc` with `hidepid=invisible`, and turns on zswap and the quotas of `/home`;
- creates the folder of the shared VS Code store and its service user;
- turns on unattended upgrades, with a fixed time outside the lessons for the reboot after a kernel update;
- installs the host service.

The playbook runs with `ansible-pull` on a systemd timer: the host fetches its configuration from Git itself, in the same way as the host service connects out to the page. No machine outside needs SSH access as root.

### Layer 3: the students

The host service, not Ansible, creates, locks and removes the Linux users and writes their keys, because these follow the management page (see [The life of a student's Linux user](#the-life-of-a-students-linux-user)).

### Tests of the setup

A test host on af.stack, created by layer 1 from the same files, gets each change of the playbook first. A short test then checks the walls of level 1: student A cannot reach a published port of student B, `ps` shows no process of another student, `/tmp` is private, and `docker info` of a student shows a rootless engine. Only then does the course host get the change.

### Open choices of the setup

- Where the playbook lives: a folder `host/` in the Devspaces 2 repository (recommended for now), or a repository of its own, for example `nimblescape/devspaces-host`, once the host service is its own program or the configuration must be private.
- OpenTofu or Heat for layer 1.
- The Linux distribution of the host: Debian 13 or Ubuntu 24.04.
