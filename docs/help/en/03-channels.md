---
title: "Channels — Team Chat"
icon: "📢"
order: 3
---

# Channels -- Team Chat

> Channels are where your team talks together. Real-time messages, AI assistance, and task execution -- all in one shared space.

---

## What is a Channel?

A Channel is a multi-user chat room. While Sessions are private 1-on-1 AI conversations, Channels are shared spaces where team members and AI collaborate together.

Use Channels for project discussions, technical questions, work coordination, and anything that benefits from team visibility.

---

## Creating a Channel

1. Select the **Channel** tab in the Sidebar.
2. Click the **+ button** at the top.
3. Enter a channel name.
4. Done -- invite your teammates.

Choose descriptive names that make the channel's purpose clear. Examples: `frontend-refactor`, `api-design`, `weekly-standup`.

---

## Joining and Leaving

### Joining a Channel

- Click any channel in the channel list to join
- You can also join via an invitation link

### Leaving a Channel

- Open the channel header settings menu -- select **Leave**
- Leaving does not delete the channel; other members can still use it

---

## Real-Time Messages

Channel messages sync in real time across all participants.

- Messages appear instantly for everyone when sent
- **Typing indicator**: When someone is typing, you see "User is typing..." below the messages
- **Unread badge**: New messages show an unread count on the channel in the Sidebar

---

## @ai Mention -- Quick AI Reply

Type `@ai` followed by your question in any channel, and AI responds directly in the conversation.

```
@ai What does this error message mean?
```

### How it works

- **Fast response**: Instant answers to straightforward questions
- **Visible to everyone**: AI's reply appears in the channel for the whole team
- **Context-aware**: AI considers recent channel conversation as context

### When to use @ai

- Quick technical questions
- Code snippet explanations
- Simple fact-checking
- Information requests that benefit the whole team

---

## @task Mention -- Full Task Execution

Type `@task` in a channel to have AI run a complex background task.

```
@task Write unit tests for this module
```

### @ai vs @task

| Aspect | @ai | @task |
|--------|-----|-------|
| Response type | Text reply in channel | Background task execution |
| Time | Seconds | Minutes to hours |
| Scope | Q&A, explanations | Code writing, file editing, analysis |
| Tracking | Streams in chat | Track on Kanban board |
| Output | Chat message | File changes, reports, etc. |

### @task examples

```
@task Generate API response schema documentation
@task Refactor the token expiration logic in auth.ts
@task Compile this week's issues into a summary report
```

When a task is created, you can track its progress on the Kanban board.

---

## Threads -- Deep Discussions

Open a Thread on any channel message to have a focused side conversation without cluttering the main channel.

### Opening a Thread

1. Hover over a channel message.
2. Click the **Reply** button or speech bubble icon.
3. The Thread panel opens for that message.

### Why use Threads

- Keep the main channel clean while diving into details
- Focus on a specific topic without noise
- You can use @ai and @task inside Threads too

---

## Message Replies

Reply to a specific message to maintain conversation flow:

1. Hover over a message.
2. Click the **Reply** button.
3. The original message is quoted, and you can write your reply.

Replies stay linked to the original message, making it easy to follow the conversation.

---

## Member Management

### Viewing members

Click the member icon in the channel header to see the current participant list.

### Inviting members

1. Open the member management menu in the channel header.
2. Search for the user you want to invite.
3. Select them to send the invitation.

### Removing members

Channel creators and Admins can remove members from a channel.

---

## Tips

- **@ai for quick, @task for heavy**: Use @ai for simple questions and @task for real work.
- **Use Threads liberally**: Move long discussions into Threads to keep the channel readable.
- **Naming convention**: Use `project-topic` format for channel names. Examples: `tower-frontend`, `kap-data-analysis`.
- **Check notifications**: Stay on top of important channels by monitoring your notification bell.
