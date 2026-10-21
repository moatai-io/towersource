-- Candidate only; install after explicit customer identity deployment approval.
create table cp_user_identities (
 issuer text not null,
 subject_id uuid not null,
 organization_id uuid not null,
 user_id integer not null references users(id),
 created_at timestamptz not null default now(),
 primary key(issuer,subject_id,organization_id),
 unique(user_id)
);
