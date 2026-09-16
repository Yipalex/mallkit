# Contributing

Thanks for taking an interest.

## How this repository is maintained

`admin/` and `miniprogram/` are **generated**. They are mirrored from a private
repository where development happens, transformed by `tools/sync/sync.mjs` to
remove private configuration and brand-specific content.

A commit made directly to those directories will be overwritten the next time
the sync runs. This is not a policy choice about your change, it is mechanical.

## Reporting a bug

Open an issue. Include the version (the `sync(...)` commit you are on), what
you did, what happened, and what you expected. For the mini program, the page
path helps. For the backend, the relevant log lines help.

## Proposing a change

Open an issue first for anything beyond a typo, so we can agree on the approach
before you spend time on it.

You are welcome to open a pull request. It will be reviewed here, then applied
to the upstream repository and reach this repository through the next sync,
credited to you. The pull request itself will be closed rather than merged, for
the mechanical reason above. That is not a rejection.

Documentation under `docs/`, plus `README.md` and this file, live in this
repository and can be merged directly.

## Sync tooling

`tools/sync/` is maintained here. If you change it, run
`node tools/sync/selftest.mjs`, which builds throwaway repositories and
exercises the engine end to end. Add a case for whatever you changed.

## Security

Do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository instead.
