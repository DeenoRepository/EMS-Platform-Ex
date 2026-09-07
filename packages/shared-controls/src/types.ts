export type ControlVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ControlSize = 'small' | 'medium' | 'large';

export interface ButtonProps {
  readonly label: string;
  readonly variant?: ControlVariant;
  readonly size?: ControlSize;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onClick?: () => void;
}

export interface InputProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly error?: string;
  readonly type?: 'text' | 'password' | 'email';
  readonly onChange?: (val: string) => void;
}

export interface TextareaProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly error?: string;
  readonly rows?: number;
  readonly onChange?: (val: string) => void;
}

export interface CheckboxProps {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange?: (checked: boolean) => void;
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly error?: string;
  readonly onChange?: (val: string) => void;
}

export interface BadgeProps {
  readonly label: string;
  readonly tone?: 'info' | 'success' | 'warning' | 'error' | 'neutral';
}

export interface AlertProps {
  readonly title: string;
  readonly message?: string;
  readonly tone?: 'info' | 'success' | 'warning' | 'error';
}

export interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly onClose?: () => void;
}

export interface TableColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly render?: (row: T) => string | number;
}

export interface TableProps<T> {
  readonly columns: readonly TableColumn<T>[];
  readonly data: readonly T[];
  readonly emptyMessage?: string;
  readonly loading?: boolean;
}
