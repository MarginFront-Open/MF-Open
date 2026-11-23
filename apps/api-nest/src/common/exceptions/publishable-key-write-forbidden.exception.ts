import { ForbiddenException } from '@nestjs/common';

/**
 * WHAT THIS IS:
 *   The 403 thrown by PublishableKeyWriteGuardInterceptor — and ONLY that one —
 *   when a request authenticated with a publishable key (mf_pk_*) tries to write
 *   (POST/PUT/PATCH/DELETE).
 *
 * WHY A DEDICATED SUBCLASS INSTEAD OF A BARE ForbiddenException:
 *   The customer-failure alert filter pages the alerts channel with copy that
 *   ASSERTS a root cause: "a customer is using a publishable key (mf_pk_) to
 *   write." But a bare 403 is produced by 10+ OTHER sources — RBAC role denials,
 *   owner-only guards, "admins cannot change other admins," etc. Those are all
 *   authenticated (req.user is set), so the service treats them as "trusted" and
 *   they SKIP the scanner-noise gate — meaning every unrelated 403 would page
 *   with a flatly false publishable-key claim.
 *
 *   Subclassing ForbiddenException lets the filter recognize THIS rejection by
 *   identity (instanceof) and alert on only it, while ignoring every other 403.
 *   Because it still extends ForbiddenException, the HTTP response the client
 *   sees is unchanged — same 403 status, same body, same message.
 */
export class PublishableKeyWriteForbiddenException extends ForbiddenException {}
