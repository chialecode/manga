# Installer behavior

The NSIS uninstall flow exposes exactly three choices:

1. Remove the application only and preserve user data.
2. Remove the application and caches/logs while preserving the database and recordings.
3. Remove the application and all application-owned data after explicit confirmation.

No option reads, writes, moves, renames, or deletes files under an authorized media library root.
