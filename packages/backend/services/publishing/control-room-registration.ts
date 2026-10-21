import { addControlRoomEntry, type ControlRoomEntry } from '../../../shared/publishing/control-room-registry.js';
import { readProjectWorkspaceFileBytes, compareAndSwapProjectWorkspaceText, type ProjectWorkspaceFileReference } from '../project-environment/project-workspace-files.js';
/** Internal primitive; caller must resolve an authorized registry reference and verify dashboard target. */
export async function addRegisteredDashboard(reference:ProjectWorkspaceFileReference,actorUserId:number,entry:ControlRoomEntry){
 const before=(await readProjectWorkspaceFileBytes({reference,actorUserId,maxBytes:65536})).bytes.toString('utf8');
 const content=addControlRoomEntry(before,entry);
 if(content===before)return {changed:false};
 await compareAndSwapProjectWorkspaceText({reference,actorUserId,expectedContent:before,content});
 return {changed:true};
}
