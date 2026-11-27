# Security

beekeep runs AI agents on people's computers, so security reports matter a lot here.

## Reporting a problem

Please report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Do not open a public issue for it.

You will get an answer within a few days. Once it is fixed, you are credited in the release notes unless you prefer not to be.

## What counts

Anything that lets a bee, a web page, a file a bee reads, another website open in the browser, or the command line or MCP do what only the person should be able to, for example:

- an action running without the approval it needs, or an "always allow" covering more than it says;
- a bee approving its own request, widening its own permissions, or acting after it was stopped;
- reaching the local server from another website, or reading its secret;
- text from a bee or a page changing the person's terminal;
- a bee in its own git copy changing the person's repository.

The design and its limits are described under "Safety" in the [README](README.md).
