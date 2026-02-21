# Backlog

## Zero-downtime deployment

**Pain point:** Deploying a new server version kills all active Claude sessions. Users lose their in-progress work and context with no warning.

**UX requirement:** Ongoing sessions must not be interrupted by a deployment. New connections go to the new version; existing sessions continue on the old version until they finish naturally.
