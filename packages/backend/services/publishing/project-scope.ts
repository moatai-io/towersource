/** Legacy folder attribution is accepted only when its ownership is unambiguous. */
export function scopePublications<T extends { project?: string }>(
  items: readonly T[], folderById: Record<string,string>, memberIds: readonly string[], selectedProjectId?: string,
): Array<T & { ownerProjectId: string }> {
  const owners = new Map<string, Set<string>>();
  for (const [id,folder] of Object.entries(folderById)) {
    for(const key of [id,folder]) { const ids=owners.get(key)||new Set<string>();ids.add(id);owners.set(key,ids); }
  }
  const members=new Set(memberIds);
  if(selectedProjectId&&!members.has(selectedProjectId))return [];
  return items.flatMap(item=>{
    const candidates=item.project?owners.get(item.project):undefined;
    if(!candidates||candidates.size!==1)return [];
    const ownerProjectId=[...candidates][0];
    if(!members.has(ownerProjectId)||(selectedProjectId&&selectedProjectId!==ownerProjectId))return [];
    return [{...item,ownerProjectId}];
  });
}
