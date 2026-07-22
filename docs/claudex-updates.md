# Claudex update model

This fork keeps two intentional branch roles:

- `upstream-main` is a clean mirror of `pingdotgg/t3code:main`.
- `main` is the release branch. It contains the Claudex UI themes and any future source-level customizations.

The scheduled **Sync upstream** workflow fast-forwards `upstream-main` every Monday and opens a pull request from `upstream-main` to `main`. It never overwrites the custom branch. Review, resolve any conflict, run the relevant checks, and merge the pull request before producing a Claudex build.

## Models and local state

Provider instances, custom model IDs, credentials, and the selected theme are user data, not repository configuration. The source supports custom models through the provider settings UI; do not commit provider tokens or endpoints to this fork.

Before switching the desktop launcher to a build from this fork, make a private backup of `~/.config/t3code`. Keep the same desktop application identity so that directory remains the active profile. The release smoke check must confirm that an existing provider instance and its selected model are still present.

## Releasing a Claudex build

Build from a reviewed commit on `main` using the existing Linux artifact command:

```bash
vp run dist:desktop:linux
```

Install the resulting artifact alongside the existing application first. Do not replace the working launcher until the new build has opened the existing profile, retained the selected theme, and connected to an already configured provider.
