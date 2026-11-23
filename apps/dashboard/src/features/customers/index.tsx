'use client'

import { useState } from 'react'
import {
  Customer,
  useCustomers,
  useDeleteCustomer,
} from '@/services/customers-service'
import { PlusIcon, TrashIcon, Pencil, Eye } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { Page } from '@/components/layouts/page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ColumnDef, DataTable } from '@/features/datatable'
import { CreateCustomerForm } from './components/create-customer-form'
import { UpdateCustomerForm } from './components/update-customer-form'

export default function CustomersPage() {
  const { toast } = useToast()
  const router = useRouter()

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [deleteCustomerId, setDeleteCustomerId] = useState<string | null>(null)
  const [isDeleteAlertOpen, setIsDeleteAlertOpen] = useState(false)
  const [showUpdateForm, setShowUpdateForm] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    null
  )

  const [queryParams, setQueryParams] = useState<Record<string, any>>({
    limit: 10,
    page: 1,
    sortBy: 'createdAt',
    sortOrder: 'desc',
    search: '',
  })

  const { data, isLoading, refetch } = useCustomers({
    limit: queryParams.limit,
    page: queryParams.page,
    sortBy: queryParams.sortBy,
    sortOrder: queryParams.sortOrder,
    search: queryParams.search,
  })

  const customers = data?.results || []
  const totalResults = data?.totalResults || 0

  const { mutate: deleteCustomer, isPending: isDeleting } = useDeleteCustomer()

  const handleDelete = async () => {
    if (!deleteCustomerId) return

    deleteCustomer(deleteCustomerId, {
      onSuccess: () => {
        toast({
          title: 'Success',
          description: 'Customer deleted successfully',
        })
        setIsDeleteAlertOpen(false)
        setDeleteCustomerId(null)
        refetch()
      },
      onError: (error) => {
        console.error('Error deleting customer:', error)
        toast({
          variant: 'destructive',
          title: 'Error',
          description: 'Failed to delete customer',
        })
      },
      onSettled: () => {
        setIsDeleteAlertOpen(false)
      },
    })
  }

  const confirmDelete = (customerId: string) => {
    setDeleteCustomerId(customerId)
    setIsDeleteAlertOpen(true)
  }

  const handleEditCustomer = (customer: Customer) => {
    setSelectedCustomer(customer)
    setShowUpdateForm(true)
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString()
  }

  const handleUpdateSuccess = () => {
    setShowUpdateForm(false)
    refetch()
  }

  const handleCreateSuccess = () => {
    setShowCreateForm(false)
    refetch()
  }

  const columns: ColumnDef<Customer>[] = [
    {
      id: 'name',
      header: 'Customer Name',
      accessorKey: 'name',
      enableSorting: true,
      cell: (customer) => (
        <Link
          href={`/customers/${customer.id}`}
          className='font-medium text-primary hover:text-primary/80 hover:underline'
          onClick={(e) => e.stopPropagation()}
        >
          {customer.name}
        </Link>
      ),
    },
    {
      id: 'email',
      header: 'Email',
      accessorKey: 'email',
      enableSorting: true,
    },
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      enableSorting: true,
      cell: (customer) => (
        <StatusBadge status={customer.status || 'inactive'} />
      ),
    },
    {
      id: 'createdAt',
      header: 'Created',
      accessorKey: 'createdAt',
      enableSorting: true,
      cell: (customer) => (
        <span className='font-tabular text-muted-foreground'>
          {formatDate(customer.createdAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: (
        <div className='flex h-full w-full items-center justify-end'>
          Actions
        </div>
      ),
      enableSorting: false,
      cell: (customer) => (
        <div
          className='flex w-full items-center justify-end gap-2'
          onClick={(e) => e.stopPropagation()}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-foreground'
                  onClick={(e) => {
                    e.stopPropagation()
                    router.push(`/customers/${customer.id}`)
                  }}
                >
                  <Eye className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>View Details</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-foreground'
                  onClick={(e) => {
                    e.stopPropagation()
                    handleEditCustomer(customer)
                  }}
                >
                  <Pencil className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 text-muted-foreground transition-colors hover:text-destructive'
                  onClick={(e) => {
                    e.stopPropagation()
                    confirmDelete(customer.id)
                  }}
                >
                  <TrashIcon className='h-4 w-4' />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ),
    },
  ]

  return (
    <>
      <Page
        title='Customers'
        description='Manage the companies and users who subscribe to your agents.'
        headerProps={{
          breadcrumb: [{ name: 'Home', href: '/' }, { name: 'Customers' }],
        }}
      >
        <DataTable
          data={customers}
          columns={columns}
          searchConfig={{
            placeholder: 'Search customers...',
            paramKey: 'search',
            debounceTime: 300,
          }}
          paginationConfig={{
            pageParamKey: 'page',
            limitParamKey: 'limit',
            defaultPageSize: 10,
          }}
          onRowClick={(customer) => router.push(`/customers/${customer.id}`)}
          isLoading={isLoading}
          onRefresh={refetch}
          totalResults={totalResults}
          queryParams={queryParams}
          setQueryParams={setQueryParams}
          actionButton={
            <Button size='sm' onClick={() => setShowCreateForm(true)}>
              <PlusIcon className='mr-2 size-4' />
              New Customer
            </Button>
          }
        />
      </Page>

      {showCreateForm && (
        <CreateCustomerForm
          isOpen={showCreateForm}
          onOpenChange={setShowCreateForm}
          onSuccess={handleCreateSuccess}
        />
      )}

      <AlertDialog open={isDeleteAlertOpen} onOpenChange={setIsDeleteAlertOpen}>
        <AlertDialogContent className='max-w-md'>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this
              customer and its data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className='gap-2 sm:space-x-0'>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
            >
              {isDeleting ? 'Deleting...' : 'Continue'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {showUpdateForm && selectedCustomer && (
        <UpdateCustomerForm
          customer={selectedCustomer}
          isOpen={showUpdateForm}
          onOpenChange={setShowUpdateForm}
          onSuccess={handleUpdateSuccess}
        />
      )}
    </>
  )
}
