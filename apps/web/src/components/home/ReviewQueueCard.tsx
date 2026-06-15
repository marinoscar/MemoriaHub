import {
  Card,
  CardContent,
  Typography,
  Box,
  Button,
  Chip,
} from '@mui/material';
import {
  CheckCircle as CheckIcon,
  RateReview as ReviewIcon,
  ThumbDown as LowValueIcon,
  LocationOff as MissingGeoIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';

interface ReviewCounts {
  unreviewed: number;
  lowValue: number;
  missingGeo: number;
}

interface ReviewQueueCardProps {
  counts: ReviewCounts;
}

interface ReviewRow {
  label: string;
  count: number;
  path: string;
  icon: React.ReactNode;
}

export function ReviewQueueCard({ counts }: ReviewQueueCardProps) {
  const navigate = useNavigate();

  const rows: ReviewRow[] = [
    {
      label: 'Unreviewed',
      count: counts.unreviewed,
      path: '/media?classification=unreviewed',
      icon: <ReviewIcon fontSize="small" />,
    },
    {
      label: 'Low value',
      count: counts.lowValue,
      path: '/media?classification=low_value',
      icon: <LowValueIcon fontSize="small" />,
    },
    {
      label: 'Missing location',
      count: counts.missingGeo,
      path: '/media?missingGeo=1',
      icon: <MissingGeoIcon fontSize="small" />,
    },
  ];

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Review Queue
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {rows.map((row) => {
            const allClear = row.count === 0;

            return (
              <Box
                key={row.label}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {allClear ? (
                    <CheckIcon fontSize="small" color="success" />
                  ) : (
                    <Box sx={{ color: 'text.secondary', display: 'flex' }}>
                      {row.icon}
                    </Box>
                  )}
                  <Typography
                    variant="body2"
                    color={allClear ? 'text.secondary' : 'text.primary'}
                  >
                    {row.label}
                  </Typography>
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip
                    label={row.count}
                    size="small"
                    color={allClear ? 'default' : 'warning'}
                    variant={allClear ? 'outlined' : 'filled'}
                  />
                  {!allClear && (
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => navigate(row.path)}
                    >
                      Review
                    </Button>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      </CardContent>
    </Card>
  );
}
