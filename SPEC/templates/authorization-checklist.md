# Authorization checklist

Run through this for **any** new resource, endpoint, or scope. Derived from the v1 failures in
[Engineering pitfalls](../TECH/14-engineering-pitfalls.md), every one of which shipped.

> `AGENTS.md` non-negotiable 6: **every authorization change is proved, not reasoned about.**
> Attempt the forbidden action as the unprivileged actor and watch it be rejected. Reading the
> rule and concluding it looks right is not verification.

## Before writing code

- [ ] Which existing predicate covers this? **Reuse it.** Do not re-derive a membership or
      admin check inline - a predicate restated in many places will eventually be restated
      wrongly, and that is the single most reliable source of authorization bugs.
- [ ] If a new predicate is genuinely needed, is it defined **once**, in the policy module,
      and named for what it grants rather than for who typically holds it?
- [ ] Does any admin-tier check match **both** `admin` and `owner`? A bare `admin` filter
      silently excludes a club whose only admin-tier member is the Owner - which is every
      brand-new club. This shipped four separate times in v1.

## Membership, not rank

- [ ] Does this reach a nested space from a **club** role rather than from a membership row?
      Substituting an admin check for a roster row was wrong in five separate places in v1, and
      **since 2026-08-12 it is wrong in a second way**: it no longer even grants management. A
      club admin outside a race manages nothing in it. See
      [ADR-0027](../decisions/0027-race-management-requires-a-roster-row.md).
- [ ] Is the membership row the sole source of truth, for **authority as well as access**? This
      checklist asked only about access until that ADR, on the reasoning that authority
      legitimately came from the club - which is exactly the assumption that changed.
- [ ] Does the capability belong to the **club** or to the **space**? The two legitimate club acts
      over a race are creating one, which cannot need a roster row on something that does not
      exist, and reading its roster. Anything else is a space act and needs the row.

## Per scope

- [ ] Stated explicitly for club, race, Eboard **and** direct message?
- [ ] For DM: `isChannelAdmin` is constant-false, so anything admin-gated is automatically
      absent. Is that the intended behaviour, or does this feature need a DM-specific answer?
- [ ] For DM: if this produces a report, a complaint, or an escalation, **who reads it?** There
      is no admin in the conversation.

## Writes

- [ ] Is the write **idempotent**, or protected by a unique constraint? Two admins hitting
      Approve on the same request must produce one membership, one notification, one decider.
- [ ] Is it **atomic**? Multi-step flows update the request and create the membership in one
      transaction, and re-check the actor's authority in their own body.
- [ ] Does any column need authority the row-level rule cannot express? Pin state and message
      type are the known case.
- [ ] Is the **delete** rule written in the same change as the create rule? Three tables shipped
      in v1 without one.

## Revocation

- [ ] Does removing this access need to **push** a revocation, not just delete a row? Channel
      subscriptions are authorized at subscribe time and are not rechecked per message, so a
      live socket outlives the membership unless it is explicitly dropped.
- [ ] Does the cascade cover *every* dependent membership - races, car groups, Eboard, DM
      eligibility - and not only the obvious one?

## Proof

- [ ] Attempted the forbidden **read** as an unprivileged actor and got nothing back.
- [ ] Attempted the forbidden **write** directly, bypassing the UI, and watched it be rejected.
      "The button is hidden" is not evidence.
- [ ] Attempted access by **direct URL** to the guarded screen, and was redirected rather than
      shown data.
- [ ] Added a row to the permission matrix test suite covering both the allowed and the denied
      case.
