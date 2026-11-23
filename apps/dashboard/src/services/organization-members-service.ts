/**
 * Organization Members Service
 * React Query hooks for team members via Server Actions
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getTeamMembers as getTeamMembersAction,
  getTeamMember as getTeamMemberAction,
  addMember as addMemberAction,
  updateMemberRole as updateMemberRoleAction,
  removeMember as removeMemberAction,
  getInvitations as getInvitationsAction,
  resendInvitation as resendInvitationAction,
  cancelInvitation as cancelInvitationAction,
  getTeamData as getTeamDataAction,
  type TeamMember,
  type Invitation,
  type AddMemberPayload,
  type InviteMemberPayload,
  type UpdateMemberRolePayload,
} from '@/app/actions/team'
import { authClient } from '@/app/lib/auth-client'
import { useAuth } from '@/hooks/use-auth'
import { useToast } from '@/hooks/use-toast'

// Re-export types for consumers
export type {
  TeamMember,
  Invitation,
  AddMemberPayload,
  InviteMemberPayload,
  UpdateMemberRolePayload,
}

// Type alias for components that import it by this name
export type OrganizationMember = TeamMember

// Query key factory
export const teamKeys = {
  all: ['team'] as const,
  members: () => [...teamKeys.all, 'members'] as const,
  member: (id: string) => [...teamKeys.all, 'member', id] as const,
  invitations: () => [...teamKeys.all, 'invitations'] as const,
  data: () => [...teamKeys.all, 'data'] as const,
}

/**
 * Hook for getting all team members
 */
export function useTeamMembers() {
  return useQuery({
    queryKey: teamKeys.members(),
    queryFn: async () => {
      const result = await getTeamMembersAction()
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch team members')
      }
      return result.data
    },
    staleTime: 60000, // 1 minute
  })
}

/**
 * Hook for getting team members (alias)
 * @deprecated Use useTeamMembers instead
 */
export function useOrganizationMembers(_organizationId?: string) {
  // organizationId param is ignored - we use session's activeOrganizationId
  return useTeamMembers()
}

/**
 * Hook for getting a single team member
 */
export function useTeamMember(memberId: string) {
  return useQuery({
    queryKey: teamKeys.member(memberId),
    queryFn: async () => {
      const result = await getTeamMemberAction(memberId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch team member')
      }
      return result.data
    },
    enabled: !!memberId,
    staleTime: 60000,
  })
}

/**
 * Hook for getting team members and invitations combined
 */
export function useTeamData() {
  return useQuery({
    queryKey: teamKeys.data(),
    queryFn: async () => {
      const result = await getTeamDataAction()
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch team data')
      }
      return result.data
    },
    staleTime: 60000,
  })
}

/**
 * Hook for getting pending invitations
 */
export function useInvitations() {
  return useQuery({
    queryKey: teamKeys.invitations(),
    queryFn: async () => {
      const result = await getInvitationsAction()
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to fetch invitations')
      }
      return result.data
    },
    staleTime: 60000,
  })
}

/**
 * Hook for adding a member directly
 */
export function useAddMember() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (data: AddMemberPayload) => {
      const result = await addMemberAction(data)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to add member')
      }
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members() })
      queryClient.invalidateQueries({ queryKey: teamKeys.data() })
      toast({
        title: 'Success',
        description: 'Member added successfully',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for adding a member (alias)
 * @deprecated Use useAddMember instead
 */
export function useAddOrganizationMember() {
  return useAddMember()
}

/**
 * Hook for inviting a member via email
 * Uses Better Auth's organization plugin which triggers email sending
 */
export function useInviteMember() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (data: InviteMemberPayload) => {
      // Use Better Auth's organization client to invite member
      // This triggers the sendInvitationEmail callback configured in auth.ts
      const result = await authClient.organization.inviteMember({
        email: data.email,
        role: data.role,
      })
      if (result.error) {
        throw new Error(result.error.message || 'Failed to send invitation')
      }
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.invitations() })
      queryClient.invalidateQueries({ queryKey: teamKeys.data() })
      toast({
        title: 'Success',
        description: 'Invitation sent successfully',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for resending an invitation
 */
export function useResendInvitation() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await resendInvitationAction(invitationId)
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to resend invitation')
      }
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.invitations() })
      queryClient.invalidateQueries({ queryKey: teamKeys.data() })
      toast({
        title: 'Success',
        description: 'Invitation resent successfully',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for canceling an invitation
 */
export function useCancelInvitation() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await cancelInvitationAction(invitationId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to cancel invitation')
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.invitations() })
      queryClient.invalidateQueries({ queryKey: teamKeys.data() })
      toast({
        title: 'Success',
        description: 'Invitation canceled',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for updating member role
 */
export function useUpdateMemberRole() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async ({
      memberId,
      role,
    }: {
      // 'finance' is the money seat, 'developer' the
      // build/operations seat and 'legal' the matter seat.
      // Matches the union in app/actions/team.ts.
      memberId: string
      role: 'owner' | 'member' | 'admin' | 'finance' | 'developer' | 'legal'
    }) => {
      const result = await updateMemberRoleAction(memberId, { role })
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to update member role')
      }
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members() })
      queryClient.invalidateQueries({ queryKey: teamKeys.data() })
      toast({
        title: 'Success',
        description: 'Member role updated successfully',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for removing a member
 */
export function useRemoveMember() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  return useMutation({
    mutationFn: async (memberId: string) => {
      const result = await removeMemberAction(memberId)
      if (!result.success) {
        throw new Error(result.error || 'Failed to remove member')
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members() })
      queryClient.invalidateQueries({ queryKey: teamKeys.data() })
      toast({
        title: 'Success',
        description: 'Member removed successfully',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      })
    },
  })
}

/**
 * Hook for accepting an invitation
 * Uses Better Auth's built-in invitation acceptance
 */
export function useAcceptInvitation() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { refreshUser } = useAuth()

  return useMutation({
    mutationFn: async (invitationId: string) => {
      // Use Better Auth's organization client to accept invitation
      const result = await authClient.organization.acceptInvitation({
        invitationId,
      })
      if (result.error) {
        throw new Error(result.error.message || 'Failed to accept invitation')
      }
      return result.data
    },
    onSuccess: async () => {
      await refreshUser()
      queryClient.invalidateQueries({ queryKey: ['organization'] })
      queryClient.invalidateQueries({ queryKey: teamKeys.members() })
      queryClient.invalidateQueries({ queryKey: teamKeys.data() })
      toast({
        title: 'Success',
        description: 'Invitation accepted successfully',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      })
    },
  })
}
