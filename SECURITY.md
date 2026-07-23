# Security policy

## Reporting a vulnerability or exposure

Please do not open a public issue for a vulnerability, leaked credential, or personal-data
exposure. Use GitHub's **Report a vulnerability** flow on this repository's Security tab so the
maintainers can investigate privately.

Include:

- the affected route, component, or commit;
- a minimal reproduction;
- the likely impact;
- whether any credential or personal record may have been exposed.

Do not include real secrets or personal data in the report. Revoke an exposed credential at its
provider immediately; repository cleanup is not a substitute for rotation.

## Deployment responsibility

ContenderOS processes sensitive career data. Self-hosters are responsible for configuring the
allowlist, authentication provider, secure cookies, database access, encryption key, backups, and
network isolation before using real CV data. The backend is intended to remain private behind the
authenticated frontend proxy.
