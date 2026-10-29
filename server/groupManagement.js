function isGroupMember(group, userId) {
    return Boolean(group?.members?.some((member) => member.toString() === userId.toString()));
}

function isGroupAdmin(group, userId) {
    return isGroupMember(group, userId) && group.admin?.toString() === userId.toString();
}

function canRemoveGroupMember(group, actorId, memberId) {
    return actorId.toString() !== memberId.toString() && isGroupAdmin(group, actorId) && isGroupMember(group, memberId);
}

function getLeaveGroupUpdate(group, userId) {
    const members = group.members.filter((member) => member.toString() !== userId.toString());
    if (members.length === 0) return { deleteGroup: true, members: [], admin: null };
    const adminLeaves = group.admin?.toString() === userId.toString();
    return { deleteGroup: false, members, admin: adminLeaves ? members[0] : group.admin };
}

module.exports = { isGroupMember, isGroupAdmin, canRemoveGroupMember, getLeaveGroupUpdate };
