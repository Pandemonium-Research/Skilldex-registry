# Removing your content from the Skilldex registry

The registry indexes publicly available `SKILL.md` files from GitHub. Most of it was imported
in bulk from the [GitSkills dataset](https://zenodo.org/records/21875637), which means content
may appear here from accounts that never submitted anything to Skilldex directly.

If that includes you, you can have it removed. There is no form to fill in and no account to
create.

---

## How to ask

Open an issue on the registry repository, or email the maintainers, with:

- **What to remove** — a GitHub handle, a repository, or a single skill URL.
- **Confirmation you control it** — a reply from the email on the GitHub account, a commit
  signed by that account, or a gist created under it. Anything that shows the request is yours.

We do not require a reason.

## What happens

| Scope | What it covers |
|---|---|
| **Owner** | Every skill attributed to that GitHub account, including anything imported later |
| **Repository** | Every skill from one repository |
| **Skill** | One skill |

Once applied:

1. The matching rows are **deleted** from the registry — not hidden behind a flag. They stop
   appearing in search, on the website, and through the CLI immediately.
2. A permanent rule is recorded. The nightly sync and every future corpus rebuild consult it
   before inserting anything, so **the content cannot come back on its own**.
3. Publishing into a removed namespace is refused until the rule is lifted.

We aim to action requests within a few days.

## What it does not do

- **It does not delete anything from GitHub.** The registry only ever stored metadata — name,
  description, score, and a link. The original repository is untouched and remains public
  unless you change that yourself.
- **It does not reach copies elsewhere.** The GitSkills dataset is published independently
  under its own DOI; removing content here has no effect on that dataset or on anyone else's
  copy of it.
- **It is not reversible for install counts.** If you later ask to be re-listed, the skills
  return from source on the next sync, but their install history does not.

## Changing your mind

Ask the same way. Lifting the rule allows the content to be indexed again on the next sync.

---

## For maintainers

```bash
# Always look first — an owner-scope removal on a bulk uploader can be tens of thousands of
# rows, and they are gone afterwards.
npm run delist -- preview owner someuser

npm run delist -- add owner someuser --reason "author request" --by "@someuser"
npm run delist -- add repo  someuser/their-skills
npm run delist -- add skill someuser/one-skill

npm run delist -- list
npm run delist -- remove owner someuser
```

`add` records the tombstone, deletes matching rows, and refreshes the registry counts.

**Never purge the `delistings` table** — on a rebuild, a schema reset, or anything else. It is
the only thing stopping the next corpus build from re-importing removed content.
`scripts/corpus/build.ts` reads it from the live database while importing, and
`scripts/corpus/merge-live.ts` copies it into the built file.

Design rationale is in
[REGISTRY_MIGRATION_DECISIONS.md](REGISTRY_MIGRATION_DECISIONS.md) (D18) and the schema comments
in `schema/sqlite/003_delistings.sql`.
