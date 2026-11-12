# Challenge Sync — Product Manifest

## What this is

Challenge Sync helps a company run internal posting challenges. A company invites its people,
sets up a challenge and its rules, and gets a leaderboard based on the performance of each person's
LinkedIn posts.

The product should make it easy to answer three questions:

- How does this challenge work?
- How am I doing?
- How is everyone in the company doing?

## Company and challenge setup

A company admin can:

- create a company;
- invite people to join it;
- create and configure a challenge;
- explain the challenge and its scoring in plain language; and
- view the challenge leaderboard and each participant's results.

For now, every member of a company participates in every challenge that company runs. We do not
need separate challenge enrollment.

A challenge defines the period being measured and how the collected LinkedIn results turn into a
ranking. Participants should always be able to see the rules that produced the leaderboard.

## Participant experience

A participant joins their company and installs the browser extension. The extension checks that
they are:

- signed in to LinkedIn; 

If either is missing, the extension prompts them to fix it. Once both are true, it can collect the
participant's own post analytics in the background.

Collection is tied to the person and company, not to a particular challenge. When that person is in
a challenge, the server uses the posts and analytics relevant to the challenge period to calculate
their place. This lets a newly created challenge use the appropriate data without asking everyone
to reconnect the extension for each challenge.

## LinkedIn data we care about

For each post, collect the analytics LinkedIn shows its author:

- total impressions;
- network and out-of-network impression percentages;
- members reached;
- profile views from the post;
- followers gained from the post;
- reactions;
- comments;
- reposts;
- saves; and
- link engagements, when the post contains a link.

We also need the participant's posts and enough basic profile information to identify them and show
their results. Audience demographics are not part of the core product right now.

## Results

The main result is a live challenge leaderboard. A participant can see their rank and the posts and
analytics that contributed to it. An admin can see the same information across the company.

The presentation should feel familiar to someone who has viewed post analytics on LinkedIn: start
with the overall result, then allow a person to inspect the individual posts behind it.

## Privacy boundary

The extension reads only the participant's own LinkedIn data through the LinkedIn session already
open in their browser. It does not collect or transmit their LinkedIn password or session cookies.
Installing and connecting the extension is the participant's consent to share these analytics with
their company for its challenges.

## Not core right now

- LinkedIn audience demographics;
- choosing different subsets of company members for each challenge; and
- implementation details for scraping, storage, APIs, routing, deployment, or the database.

Those details belong in the technical documentation and can evolve without changing this product
manifest.
