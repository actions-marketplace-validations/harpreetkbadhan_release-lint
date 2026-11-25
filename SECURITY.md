# Security

release-lint parses untrusted files: if a crafted `.ipa` or `.aab` makes it crash, hang, use a lot of memory, print an
unmasked secret, or write anything to disk, that is a security bug.

Please report it privately with GitHub's **Report a vulnerability** button (Security tab), not in a public issue.
Include the release-lint version and a way to reproduce it with a synthetic file. Never attach someone else's app.

Only the latest 0.x release gets fixes.
