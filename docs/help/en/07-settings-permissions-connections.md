---
title: "Settings, Permissions, and Connections"
icon: "⚙️"
order: 7
---

# Settings, Permissions, and Connections

Tower separates personal preferences, Project authority, server administration, and external account Connections.

## My Settings

Open **My Settings** to manage personal options such as:

- profile and password;
- language;
- light or dark appearance;
- font size;
- notification delivery and event groups;
- personal external-service Connections when available.

These settings belong to your user account. They do not automatically change another member's preferences or a Project's authority policy.

## Project permissions

A Project is the boundary for files, Sessions, members, and AI teammate authority.

Depending on your role, Project settings can control:

- who can access the Project;
- member roles;
- the Primary AI teammate profile;
- tool and authority policy;
- available Skills;
- which organization or personal Connections the AI teammate may use.

Inviting an agent to a collaboration surface does not automatically grant that agent access to another Project's files or Credentials.

## Connections and Credentials

A **Connection** represents an approved external service account and its usage policy. The underlying API key, OAuth token, password, or credential document is stored in Credential Vault.

Secret values should never be pasted into chat or committed to Project files.

Connection readiness has three separate stages:

1. The Connection is configured and allowed for the current user or Project.
2. The Credential is materialized into the eligible runtime command.
3. The provider accepts the authentication.

If a service fails, review the reported stage and next action. A provider authentication error alone does not prove that the Connection was removed.

## Personal and organization Connections

A personal Connection can be made available to selected Project AI teammates for work that you initiate. It is not automatically passed to other members' Sessions or externally deployed AI services.

An organization Connection is prepared by an administrator and can be granted or blocked for specific AI teammates or Projects according to policy.

Disconnecting a Connection can immediately stop future use while preserving recoverable metadata or access policy, depending on the server configuration.

## Models and AI policy

Administrators can configure available providers, models, and default model policies for primary work, utility work, and background execution.

The Admin Panel does not treat an editable raw system prompt as the sole source of AI behavior. Tower combines product policy, organization configuration, Project `AGENTS.md`, runtime context, Skills, and authority policy.

## Notifications

Notification settings can control:

- Notification Center entries;
- in-app toast messages;
- browser or PWA push notifications;
- mentions and direct requests;
- long-task completion;
- failures that need action;
- general AI and work updates.

Browser push requires both browser permission and server configuration.

## Administrator and operator actions

Admin and operator surfaces can affect shared users, Projects, providers, and runtime infrastructure. Actions such as deployment, restart, credential policy changes, bulk membership changes, and system configuration should show their impact and require the appropriate role or confirmation.

Do not infer authority from the presence of a button or file path. Tower validates the current principal and operation on the backend.
