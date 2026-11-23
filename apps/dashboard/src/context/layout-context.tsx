import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from 'react'

// Define types for layout options
export interface LayoutOptions {
  sidebar?: boolean
  navbar?: boolean
  pageTitle?: string
  topNav?: {
    title: string
    href: string
    isActive: boolean
    disabled?: boolean
  }[]
  breadcrumbs?: {
    title: string
    href?: string
    isCurrent?: boolean
  }[]
}

interface LayoutContextType {
  options: LayoutOptions
  updateOptions: (newOptions: Partial<LayoutOptions>) => void
  resetOptions: () => void
}

// Create the context with default values
const LayoutContext = createContext<LayoutContextType>({
  options: {
    sidebar: true,
    navbar: true,
    topNav: [],
    breadcrumbs: [],
  },
  updateOptions: () => {},
  resetOptions: () => {},
})

// Custom hook to use the layout context
export const useLayout = () => useContext(LayoutContext)

// Provider component
interface LayoutProviderProps {
  children: ReactNode
  defaultOptions?: LayoutOptions
}

export const LayoutProvider: React.FC<LayoutProviderProps> = ({
  children,
  defaultOptions = {
    sidebar: true,
    navbar: true,
    topNav: [],
    breadcrumbs: [],
  },
}) => {
  const [options, setOptions] = useState<LayoutOptions>(defaultOptions)

  // Update layout options
  const updateOptions = useCallback((newOptions: Partial<LayoutOptions>) => {
    setOptions((prevOptions) => ({
      ...prevOptions,
      ...newOptions,
    }))
  }, [])

  // Reset to default options
  const resetOptions = useCallback(() => {
    setOptions(defaultOptions)
  }, [defaultOptions])

  return (
    <LayoutContext.Provider value={{ options, updateOptions, resetOptions }}>
      {children}
    </LayoutContext.Provider>
  )
}
