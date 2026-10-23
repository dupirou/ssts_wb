"""One trust store for every official fetch.

certifi carries Mozilla's current root list, so a CA the browsers drop is dropped here as soon as
certifi releases, not whenever the Actions runner image refreshes its system store. 2026.10.19
removed eMudhra's emSign ECC Root CA - G3 after its intermediate keys proved recoverable.
"""

import ssl
import certifi

CONTEXT = ssl.create_default_context(cafile=certifi.where())
