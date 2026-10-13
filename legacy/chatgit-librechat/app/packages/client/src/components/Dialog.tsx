import * as React from 'react';
import { X } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn, disabledFillClasses } from '~/utils';
import { Button, ButtonProps } from './Button';
import { useMediaQuery } from '~/hooks';

const Dialog: React.FC<DialogPrimitive.DialogProps> = DialogPrimitive.Root;

const DialogTrigger: React.ForwardRefExoticComponent<
  DialogPrimitive.DialogTriggerProps & React.RefAttributes<HTMLButtonElement>
> = DialogPrimitive.Trigger;

type DialogPortalProps = DialogPrimitive.DialogPortalProps & { className?: string };

const DialogPortal = ({ className = '', children, ...props }: DialogPortalProps) => (
  <DialogPrimitive.Portal className={cn(className)} {...(props as DialogPortalProps)}>
    <div className="fixed inset-0 z-[999] flex items-start justify-center sm:items-center">
      {children}
    </div>
  </DialogPrimitive.Portal>
);
DialogPortal.displayName = DialogPrimitive.Portal.displayName;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    className={cn(
      'bg-scrim-modal data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in fixed inset-0 z-[999] transition-opacity duration-100 motion-reduce:animate-none motion-reduce:transition-none',
      className ?? '',
    )}
    {...props}
    ref={ref}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  disableScroll?: boolean;
};

const DialogContent: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> & {
    showCloseButton?: boolean;
    disableScroll?: boolean;
  } & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  (
    { className, children = true, showCloseButton = true, disableScroll = false, ...props },
    ref,
  ) => {
    const isSmallScreen = useMediaQuery('(max-width: 768px)');
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            /** Arc's raised surface uses the same theme contract as settings dialogs. */
            'bg-surface-dialog border-border-light rounded-theme-surface animate-in data-[state=open]:fade-in-90 high-contrast:border high-contrast:border-solid high-contrast:border-border-medium high-contrast:shadow-none fixed z-[999] grid w-full gap-4 border-(length:--theme-dialog-stroke) pb-6 shadow-2xl motion-reduce:animate-none',
            isSmallScreen
              ? 'fixed top-1/2 left-1/2 m-auto w-11/12 -translate-x-1/2 -translate-y-1/2'
              : '',
            disableScroll ? 'overflow-hidden' : '',
            className ?? '',
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close className="border-border-light bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-focus-control absolute top-3 right-3 flex size-11 items-center justify-center rounded-lg border focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none">
              <X className="text-text-primary size-theme-icon-md" aria-hidden="true" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader: {
  ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
  displayName: string;
} = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div
    className={cn('flex flex-col space-y-2 p-6 pe-16 pb-4 text-start', className ?? '')}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter: {
  ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
  displayName: string;
} = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div
    className={cn('flex flex-row justify-between space-x-2 px-6 py-4', className ?? '')}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogTitleProps & React.RefAttributes<HTMLHeadingElement>, 'ref'> &
    React.RefAttributes<HTMLHeadingElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-text-primary font-display text-lg font-semibold', className ?? '')}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogDescriptionProps & React.RefAttributes<HTMLParagraphElement>, 'ref'> &
    React.RefAttributes<HTMLParagraphElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-text-secondary text-sm', className ?? '')}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

const DialogClose: React.ForwardRefExoticComponent<
  Omit<DialogPrimitive.DialogCloseProps & React.RefAttributes<HTMLButtonElement>, 'ref'> &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    className={cn(
      'border-border-light text-text-primary hover:bg-surface-hover h-theme-button mt-2 inline-flex items-center justify-center rounded-lg border bg-transparent px-4 py-2 text-sm font-semibold transition-colors focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0',
      disabledFillClasses,
      className ?? '',
      /* Important: for accessibility */
      'focus:ring-focus-control focus:ring-2 focus:ring-offset-2',
    )}
    {...props}
  />
));
DialogClose.displayName = DialogPrimitive.Title.displayName;

const DialogButton: React.ForwardRefExoticComponent<
  Omit<ButtonProps & React.RefAttributes<HTMLButtonElement>, 'ref'> &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof Button>,
  React.ComponentPropsWithoutRef<typeof Button>
>(({ className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="outline"
    className={cn(
      'border-border-light text-text-primary hover:bg-surface-hover focus:ring-focus-control h-theme-button mt-2 inline-flex items-center justify-center rounded-lg border bg-transparent px-4 py-2 text-sm font-semibold transition-colors focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0',
      disabledFillClasses,
      className ?? '',
      /* Important: for accessibility */
      'focus:ring-focus-control focus:ring-2 focus:ring-offset-2',
    )}
    {...props}
  />
));
DialogButton.displayName = DialogPrimitive.Title.displayName;

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogButton,
};
